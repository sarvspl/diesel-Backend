import { ServiceUnavailableError } from '../errors/index.js';
import { isShuttingDown } from '../lifecycle.js';

/**
 * Refuses new work once shutdown has begun.
 *
 * During a rolling deploy the load balancer needs a moment to notice the
 * instance is going away. Until it does, requests keep arriving on existing
 * keep-alive connections. Answering them with 503 + `Connection: close` tells
 * the client to retry elsewhere instead of having the socket cut mid-response.
 *
 * In-flight requests are unaffected — they are allowed to finish during the
 * drain window.
 */
export const rejectDuringShutdown = (_req, res, next) => {
  if (!isShuttingDown()) return next();

  res.set('Connection', 'close');
  return next(new ServiceUnavailableError('Server is shutting down, please retry'));
};
