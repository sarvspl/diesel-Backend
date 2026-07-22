import { ERROR_CODES } from '../constants/error-codes.js';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../errors/index.js';

/**
 * Ownership middleware - foundation.
 *
 * Answers "may this caller act on THIS PARTICULAR record?", which permissions
 * alone cannot: `session.revoke.self` says a user may revoke sessions, not that
 * this session is theirs.
 *
 * Two rules encoded here, both from the docs:
 *
 *  1. Scope comes from the TOKEN, never from a request parameter (BR-225).
 *     A caller must not be able to widen their own scope by editing an id.
 *
 *  2. A record the caller may not see returns 404, not 403 (docs/10 §6).
 *     A 403 confirms the record exists, which is itself a disclosure.
 *
 * Later modules extend this with corporate scoping - an order is visible if it
 * belongs to the caller's corporate account - which is why the resolver is a
 * parameter rather than hard-coded.
 */

/**
 * Allow when the caller owns the resource, OR holds an override permission.
 *
 * @param {object} options
 * @param {(req: import('express').Request) => Promise<{ ownerId: string }|null>} options.resolveOwner
 *        Loads the resource and reports its owner. Return null when it does not
 *        exist - the caller then gets the same 404 as an unauthorised caller.
 * @param {string} [options.overridePermission]
 *        Permission that bypasses the ownership check, e.g. `session.revoke.any`.
 * @param {string} [options.notFoundMessage]
 */
export const requireOwnership =
  ({ resolveOwner, overridePermission, notFoundMessage = 'Resource not found' }) =>
  async (req, _res, next) => {
    if (!req.auth) {
      return next(
        new UnauthorizedError('Authentication required', { code: ERROR_CODES.TOKEN_MISSING })
      );
    }

    // Administrative override is checked first so an admin never triggers a
    // failed ownership lookup on someone else's record.
    if (overridePermission && req.auth.permissions.includes(overridePermission)) {
      req.ownership = { isOwner: false, viaOverride: true };
      return next();
    }

    const resource = await resolveOwner(req);

    if (!resource) {
      return next(new NotFoundError(notFoundMessage));
    }

    if (resource.ownerId !== req.auth.userId) {
      req.log?.warn(
        { userId: req.auth.userId, ownerId: resource.ownerId, path: req.path },
        'ownership check failed'
      );

      // Same 404 an absent record would produce. Rule 2 above.
      return next(new NotFoundError(notFoundMessage));
    }

    req.ownership = { isOwner: true, viaOverride: false };
    return next();
  };

/**
 * The narrow, common case: a `:userId` route parameter must match the caller.
 *
 * @param {object} [options]
 * @param {string} [options.param]              Route parameter name.
 * @param {string} [options.overridePermission] Permission allowing any user.
 */
export const requireSelf =
  ({ param = 'userId', overridePermission } = {}) =>
  (req, _res, next) => {
    if (!req.auth) {
      return next(
        new UnauthorizedError('Authentication required', { code: ERROR_CODES.TOKEN_MISSING })
      );
    }

    if (overridePermission && req.auth.permissions.includes(overridePermission)) {
      return next();
    }

    if (req.params[param] !== req.auth.userId) {
      return next(
        new ForbiddenError('You may only act on your own account', {
          code: ERROR_CODES.NOT_RESOURCE_OWNER,
        })
      );
    }

    return next();
  };
