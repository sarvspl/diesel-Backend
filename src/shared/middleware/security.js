import cors from 'cors';
import helmet from 'helmet';

import { env } from '../../config/env.js';
import { ForbiddenError } from '../errors/index.js';

/**
 * Secure HTTP response headers.
 *
 * Helmet's defaults are appropriate for a JSON API. Note for later: when
 * Swagger UI is mounted it will need its own relaxed CSP on that route only —
 * relax it there, never globally.
 */
export const securityHeaders = helmet({
  // Allows the API to be consumed cross-origin; the CORS middleware below is
  // what actually decides who may call it.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

/**
 * CORS.
 *
 * Requests with no `Origin` header are allowed: that covers native mobile
 * clients (the Flutter customer and driver apps), server-to-server calls and
 * curl. CORS is a browser protection — it is not, and cannot be, the
 * authorisation mechanism. Authentication middleware is what protects data.
 */
const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (env.CORS_ORIGIN.includes('*') || env.CORS_ORIGIN.includes(origin)) {
      return callback(null, true);
    }

    return callback(new ForbiddenError('Origin is not allowed by CORS policy'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
  maxAge: 600,
};

export const corsMiddleware = cors(corsOptions);
