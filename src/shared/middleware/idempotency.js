import { ERROR_CODES } from '../constants/error-codes.js';
import { BadRequestError } from '../errors/index.js';

/**
 * Require and expose an `Idempotency-Key` header (docs/10 §8, BR-803).
 *
 * This middleware only VALIDATES and exposes the key. The wrapping of the
 * operation happens in the service layer, because that is where the transaction
 * boundary is and because docs/11 §1.3 requires services to be callable from a
 * background job unchanged - a service that only becomes idempotent when an
 * Express middleware wraps it is not.
 *
 * The key is validated for length and character set before use. An unvalidated
 * client string that reaches a log line is a log-injection vector, and this one
 * reaches both the log and a database column (docs/10 §10).
 */

const KEY_PATTERN = /^[A-Za-z0-9_:.-]{16,255}$/;

export const requireIdempotencyKey = (req, _res, next) => {
  const key = req.get('idempotency-key');

  if (!key) {
    return next(
      new BadRequestError(
        'This endpoint requires an Idempotency-Key header. Reuse the same key when retrying.',
        { code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED }
      )
    );
  }

  if (!KEY_PATTERN.test(key)) {
    return next(
      new BadRequestError(
        'Idempotency-Key must be 16-255 characters of letters, digits, and _ : . - (a UUID is ideal)',
        { code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED }
      )
    );
  }

  req.idempotencyKey = key;

  return next();
};
