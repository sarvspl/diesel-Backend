import { Router } from 'express';

import { PERMISSIONS } from '../../shared/constants/rbac.js';
import { authRateLimiter, refreshRateLimiter } from '../../shared/middleware/auth-rate-limit.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';

import * as authController from './controllers/auth.controller.js';
import * as sessionController from './controllers/session.controller.js';
import {
  loginSchema,
  otpRequestSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
  sessionIdSchema,
} from './identity.schema.js';

/**
 * Identity routes.
 *
 * Routing only - no logic (docs/11 §1.3). Read the middleware chain on each
 * route as the security policy for that endpoint.
 */
const router = Router();

// --- Unauthenticated -------------------------------------------------------
// Strict rate limiting: these are the endpoints an attacker actually targets.

router.post('/register', authRateLimiter, validate(registerSchema), authController.register);

router.post('/login', authRateLimiter, validate(loginSchema), authController.login);

/**
 * OTP - the customer and driver authentication path (BR-101).
 *
 * Both routes carry the strict limiter as a coarse network-level guard, and the
 * OTP service applies its own per-identifier and per-IP limits on top. The two
 * are not redundant: the middleware bounds request volume, the service bounds
 * SMS spend, which is the expensive thing (BR-114).
 */
router.post('/otp/request', authRateLimiter, validate(otpRequestSchema), authController.requestOtp);

router.post('/otp/verify', authRateLimiter, validate(otpVerifySchema), authController.verifyOtp);

/**
 * Refresh is unauthenticated by design: the access token is expected to be
 * expired by the time a client calls it. The refresh token IS the credential.
 */
router.post('/refresh', refreshRateLimiter, validate(refreshSchema), authController.refresh);

// --- Authenticated ---------------------------------------------------------

router.post('/logout', authenticate, authController.logout);

router.post('/logout-all', authenticate, authController.logoutAll);

router.get('/me', authenticate, requirePermission(PERMISSIONS.USER_READ_SELF), authController.me);

router.get(
  '/sessions',
  authenticate,
  requirePermission(PERMISSIONS.SESSION_READ_SELF),
  sessionController.listSessions
);

/**
 * Ownership is enforced inside the service by scoping the lookup to
 * `req.auth.userId`, which is stronger than a middleware check: there is no
 * query that could return another user's session in the first place (BR-225).
 */
router.delete(
  '/sessions/:id',
  authenticate,
  requirePermission(PERMISSIONS.SESSION_REVOKE_SELF),
  validate(sessionIdSchema),
  sessionController.revokeSession
);

export default router;
