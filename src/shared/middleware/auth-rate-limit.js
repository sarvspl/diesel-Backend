import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { env } from '../../config/env.js';
import { TooManyRequestsError } from '../errors/index.js';

/**
 * Rate limiting for authentication endpoints.
 *
 * The global limiter is sized for ordinary API traffic and would permit
 * thousands of credential-stuffing attempts inside one window. Authentication
 * gets a far smaller, separately configured budget.
 *
 * ---------------------------------------------------------------------------
 * HORIZONTAL SCALING - carries the same caveat as the global limiter
 * ---------------------------------------------------------------------------
 * The default store is in-memory, so counters are per process. With N
 * instances the effective limit is N x the configured value. Before running
 * more than one instance, add `rate-limit-redis` and pass it as `store` here
 * and in rate-limit.js. Nothing else changes.
 */

/**
 * Key on the submitted identifier as well as the IP.
 *
 * IP alone is too coarse - an office or a mobile carrier NAT shares one address
 * across many legitimate users, and locking them out together is a denial of
 * service against real customers. Identifier alone is too narrow, since an
 * attacker just rotates it.
 *
 * `ipKeyGenerator` is used rather than raw `req.ip` because it normalises IPv6
 * to a /64 subnet; a single IPv6 host is routinely handed billions of
 * addresses, so keying on the exact address makes the limit trivially evaded.
 *
 * The identifier is truncated: it only has to be stable, and full phone numbers
 * do not belong in an in-memory key space that could surface in a heap dump.
 */
const keyByIpAndIdentifier = (req, res) => {
  const identifier = req.body?.phone ?? req.body?.email ?? '';
  return `${ipKeyGenerator(req, res)}:${String(identifier).slice(0, 64)}`;
};

const baseOptions = {
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(new TooManyRequestsError('Too many attempts. Please wait before trying again.')),
};

/**
 * Login and registration.
 *
 * Counts EVERY attempt, not only failures. Counting failures alone lets an
 * attacker who occasionally succeeds keep their budget topped up.
 */
export const authRateLimiter = rateLimit({
  ...baseOptions,
  limit: env.AUTH_RATE_LIMIT_MAX,
  keyGenerator: keyByIpAndIdentifier,
});

/**
 * Token refresh.
 *
 * Deliberately more generous: a legitimate client refreshes on a schedule and
 * several tabs or app screens may refresh at once. Still bounded, because an
 * unbounded refresh endpoint is a free oracle for testing stolen tokens.
 *
 * Keyed by IP only - the refresh token is not in the body in a form worth
 * keying on, and must never be used as a cache key.
 */
export const refreshRateLimiter = rateLimit({
  ...baseOptions,
  limit: env.AUTH_RATE_LIMIT_MAX * 6,
});
