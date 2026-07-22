import { ERROR_CODES } from '../constants/error-codes.js';
import { ForbiddenError, UnauthorizedError } from '../errors/index.js';

/**
 * Authorisation middleware.
 *
 * Code checks PERMISSIONS, never role names (ADR-008). `requireRole` exists
 * only for the rare case where a role genuinely is the subject - "this screen
 * is for super admins" - and should be reached for last, not first.
 *
 * All of these must be mounted after `authenticate`.
 */

/**
 * Returns the caller, or reports 401 through `next` and returns null.
 *
 * Reporting through `next` rather than throwing keeps every authorisation
 * middleware on one error path, which is what makes them testable without an
 * Express app around them.
 */
const getAuthenticated = (req, next) => {
  if (!req.auth) {
    next(new UnauthorizedError('Authentication required', { code: ERROR_CODES.TOKEN_MISSING }));
    return null;
  }

  return req.auth;
};

/**
 * Require every listed permission.
 *
 *   router.post('/x', authenticate, requirePermission(PERMISSIONS.USER_BLOCK), handler)
 *
 * The failure deliberately does NOT name the missing permission: telling a
 * caller exactly which grant would unlock an endpoint maps out the permission
 * model for them. It is logged server-side instead.
 *
 * @param {...string} required
 */
export const requirePermission =
  (...required) =>
  (req, _res, next) => {
    const auth = getAuthenticated(req, next);
    if (!auth) return undefined;
    const held = new Set(auth.permissions);
    const missing = required.filter((permission) => !held.has(permission));

    if (missing.length > 0) {
      req.log?.warn(
        { userId: auth.userId, required, missing },
        'authorisation denied: missing permission'
      );

      return next(
        new ForbiddenError('You do not have permission to perform this action', {
          code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        })
      );
    }

    return next();
  };

/**
 * Require at least one of the listed permissions.
 *
 * The common shape is `requireAnyPermission(SESSION_READ_SELF, SESSION_READ_ANY)`
 * on an endpoint that serves both the owner and an administrator, with the
 * ownership check narrowing it further.
 *
 * @param {...string} accepted
 */
export const requireAnyPermission =
  (...accepted) =>
  (req, _res, next) => {
    const auth = getAuthenticated(req, next);
    if (!auth) return undefined;
    const held = new Set(auth.permissions);

    if (!accepted.some((permission) => held.has(permission))) {
      req.log?.warn({ userId: auth.userId, accepted }, 'authorisation denied: missing permission');

      return next(
        new ForbiddenError('You do not have permission to perform this action', {
          code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        })
      );
    }

    return next();
  };

/**
 * Restrict an endpoint to one or more account kinds.
 *
 * This is NOT authorisation - it is surface separation. A driver token must
 * not reach a customer-app endpoint even if the permissions happen to overlap,
 * because customer and driver are separate accounts by design (ADR-016).
 *
 * @param {...string} allowed Values from PRINCIPALS.
 */
export const requirePrincipal =
  (...allowed) =>
  (req, _res, next) => {
    const auth = getAuthenticated(req, next);
    if (!auth) return undefined;

    if (!allowed.includes(auth.principal)) {
      return next(
        new ForbiddenError('This endpoint is not available for your account type', {
          code: ERROR_CODES.WRONG_PRINCIPAL,
        })
      );
    }

    return next();
  };

/**
 * Require a named role.
 *
 * Present for completeness and for genuinely role-shaped questions. Prefer
 * `requirePermission`: role checks scattered through handlers are exactly what
 * ADR-008 exists to prevent.
 *
 * @param {...string} allowed
 */
export const requireRole =
  (...allowed) =>
  (req, _res, next) => {
    const auth = getAuthenticated(req, next);
    if (!auth) return undefined;

    if (!auth.roles.some((role) => allowed.includes(role))) {
      return next(
        new ForbiddenError('You do not have permission to perform this action', {
          code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        })
      );
    }

    return next();
  };
