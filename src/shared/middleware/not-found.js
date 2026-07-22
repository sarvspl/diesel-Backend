import { ERROR_CODES } from '../constants/error-codes.js';
import { NotFoundError } from '../errors/index.js';

/**
 * Terminal 404 handler for unmatched routes.
 *
 * Uses `req.path` rather than `req.originalUrl` so that a query string — which
 * may carry a token, OTP or other secret — is never reflected back to the
 * caller or written into the error log.
 */
export const notFoundHandler = (req, _res, next) => {
  next(
    new NotFoundError(`Route ${req.method} ${req.path} not found`, {
      code: ERROR_CODES.ROUTE_NOT_FOUND,
    })
  );
};
