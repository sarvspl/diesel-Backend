import rateLimit from 'express-rate-limit';

import { env } from '../../config/env.js';
import { TooManyRequestsError } from '../errors/index.js';

/**
 * Baseline rate limit for the whole API.
 *
 * ---------------------------------------------------------------------------
 * HORIZONTAL SCALING NOTE
 * ---------------------------------------------------------------------------
 * express-rate-limit defaults to an in-memory store, so counters are per
 * process. With N instances behind a load balancer the effective limit becomes
 * N x RATE_LIMIT_MAX. That is acceptable for a coarse abuse guard on a single
 * instance, and it is the ONLY piece of in-memory state in the application.
 *
 * Before running more than one instance, add `rate-limit-redis` and pass it as
 * `store` here. No other code has to change.
 *
 * Tighter, purpose-built limiters (OTP requests per phone, login attempts per
 * account, payment retries) belong to their own modules — they need different
 * windows and different keys, and must NOT reuse this one.
 */
export const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,

  // IETF draft-8 `RateLimit` headers; the legacy `X-RateLimit-*` set is off.
  standardHeaders: 'draft-8',
  legacyHeaders: false,

  // Health checks are polled continuously by load balancers and monitoring.
  // Rate limiting them would eventually mark a healthy instance as down.
  skip: (req) => req.path === '/health',

  // Route rejections through the normal error pipeline so the response body
  // matches every other error on the API.
  handler: (_req, _res, next) =>
    next(new TooManyRequestsError('Too many requests, please try again later')),
});
