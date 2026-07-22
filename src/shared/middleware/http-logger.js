import pinoHttp from 'pino-http';

import { logger } from '../logger/index.js';

/**
 * Per-request structured logging.
 *
 * Emits one line per completed request carrying the request id, method, route,
 * status code and response time, and attaches a request-scoped child logger at
 * `req.log` so downstream code logs with the correlation id already bound.
 *
 * The serializers below are an allowlist: only the listed fields are logged.
 * Headers are never serialised at all, which means Authorization and Cookie
 * cannot leak even if the redaction list in the logger were to miss them.
 */
export const httpLogger = pinoHttp({
  logger,

  // Reuse the id assigned by the requestId middleware rather than generating
  // a second, unrelated one.
  genReqId: (req) => req.id,

  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },

  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res, err) =>
    `${req.method} ${req.url} ${res.statusCode} ${err.message}`,

  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      // `req.url` is the path within the mounted router; `originalUrl` would
      // include the query string, which can carry tokens or OTPs.
      url: req.url?.split('?')[0],
      route: req.raw?.route?.path,
      ip: req.raw?.ip,
      userAgent: req.headers?.['user-agent'],
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: (err) => ({
      type: err.name,
      message: err.message,
      code: err.code,
      statusCode: err.statusCode,
      stack: err.stack,
    }),
  },
});
