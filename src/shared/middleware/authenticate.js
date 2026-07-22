import { verifyAccessToken } from '../../modules/identity/services/token.service.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { UnauthorizedError } from '../errors/index.js';

const BEARER_PREFIX = /^Bearer\s+(.+)$/i;

/**
 * Authentication middleware.
 *
 * Verifies the access token and attaches the caller to `req.auth`:
 *
 *   req.auth = { userId, principal, sessionId, roles[], permissions[] }
 *
 * Verification is STATELESS - no database round trip. Roles and permissions
 * come from the token itself, which is why authorisation is free but a
 * permission change only takes effect when the access token expires. See the
 * trade-off note in token.service.js; anything needing immediate effect must
 * also revoke the user's sessions.
 *
 * Bearer tokens rather than cookies (docs/10 §4.1). The four clients include
 * two native mobile apps, where cookies buy nothing and cost CSRF exposure.
 */
export const authenticate = (req, _res, next) => {
  const header = req.get('authorization');

  if (!header) {
    return next(
      new UnauthorizedError('Authentication required', { code: ERROR_CODES.TOKEN_MISSING })
    );
  }

  const match = BEARER_PREFIX.exec(header);

  if (!match) {
    return next(
      new UnauthorizedError('Authorization header must be a Bearer token', {
        code: ERROR_CODES.TOKEN_INVALID,
      })
    );
  }

  let payload;

  try {
    // Raises UnauthorizedError with TOKEN_EXPIRED / TOKEN_INVALID / TOKEN_WRONG_TYPE.
    payload = verifyAccessToken(match[1]);
  } catch (error) {
    // Express 5 would catch a synchronous throw here too, but every other
    // branch in this file reports through next(). One error path per function
    // keeps the middleware independently testable.
    return next(error);
  }

  req.auth = {
    userId: payload.sub,
    principal: payload.principal,
    sessionId: payload.sid,
    roles: payload.roles ?? [],
    permissions: payload.permissions ?? [],
  };

  return next();
};
