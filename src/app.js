import express from 'express';

import v1Router from './api/v1/index.js';
import { env } from './config/env.js';
import { errorHandler } from './shared/middleware/error-handler.js';
import { httpLogger } from './shared/middleware/http-logger.js';
import { notFoundHandler } from './shared/middleware/not-found.js';
import { requestId } from './shared/middleware/request-id.js';
import { corsMiddleware, securityHeaders } from './shared/middleware/security.js';
import { rejectDuringShutdown } from './shared/middleware/shutdown-guard.js';

export const API_V1_PREFIX = '/api/v1';

/**
 * Builds the Express application.
 *
 * Exported as a factory rather than a module-level singleton so that tests can
 * create an isolated instance, and so that nothing binds a port as a side
 * effect of importing this file. Listening is `server.js`'s job.
 *
 * Middleware order below is deliberate — see the comments at each step.
 */
export const createApp = () => {
  const app = express();

  // How many proxy hops to trust for req.ip and req.protocol. Wrong values are
  // a real security problem: too permissive lets a client spoof its IP through
  // X-Forwarded-For and evade rate limiting.
  app.set('trust proxy', env.TRUST_PROXY);

  // Do not advertise the framework.
  app.disable('x-powered-by');

  // 1. Correlation id first, so every subsequent log line and every response —
  //    including one rejected by CORS — can be traced.
  app.use(requestId);

  // 2. Request logging, which reads the id assigned above.
  app.use(httpLogger);

  // 3. Security headers before anything can produce a response body.
  app.use(securityHeaders);
  app.use(corsMiddleware);

  // 4. Once draining has started, stop accepting new work. Placed before body
  //    parsing so a shutting-down instance does not spend time reading bodies
  //    it will not process.
  app.use(rejectDuringShutdown);

  // 5. Body parsing, size-capped. Oversized or malformed bodies are turned
  //    into clean 413/400 responses by the error handler.
  //
  //    Note for the payments phase: gateway webhook signatures are computed
  //    over the raw bytes, so that route needs express.raw() mounted BEFORE
  //    this JSON parser, not after.
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));

  // 6. Versioned API surface.
  app.use(API_V1_PREFIX, v1Router);

  // 7. Anything unmatched is a 404 in the standard envelope.
  app.use(notFoundHandler);

  // 8. Centralised error handling. Must be last.
  app.use(errorHandler);

  return app;
};
