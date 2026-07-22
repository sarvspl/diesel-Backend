import { HTTP_STATUS } from '../../../shared/constants/http-status.js';
import { sendCreated, sendSuccess } from '../../../shared/utils/api-response.js';
import * as authService from '../services/auth.service.js';
import * as otpService from '../services/otp.service.js';

/**
 * Thin HTTP layer: read validated input, call a service, shape a response.
 * No business logic, no database access (docs/11 §1.3).
 */

/**
 * Device metadata captured server-side.
 *
 * IP and user agent come from the request, never from the body - a client that
 * could set its own IP would defeat both session forensics and rate limiting.
 */
const deviceContext = (req) => ({
  deviceId: req.validated.body.deviceId,
  deviceName: req.validated.body.deviceName,
  platform: req.validated.body.platform,
  appVersion: req.validated.body.appVersion,
  ipAddress: req.ip,
  userAgent: req.get('user-agent')?.slice(0, 512),
});

/** POST /api/v1/auth/register */
export const register = async (req, res) => {
  const { phone, email, password, consentVersion } = req.validated.body;

  const result = await authService.register({
    phone,
    email,
    password,
    consentVersion,
    context: deviceContext(req),
  });

  return sendCreated(res, { message: 'Account created successfully', data: result });
};

/** POST /api/v1/auth/login */
export const login = async (req, res) => {
  const { principal, phone, email, password } = req.validated.body;

  const result = await authService.login({
    principal,
    phone,
    email,
    password,
    context: deviceContext(req),
  });

  return sendSuccess(res, { message: 'Logged in successfully', data: result });
};

/**
 * POST /api/v1/auth/otp/request
 *
 * 202 Accepted, not 200: the code has been queued for delivery, and whether it
 * arrives is not known when this returns.
 */
export const requestOtp = async (req, res) => {
  const { phone, principal, purpose } = req.validated.body;

  const result = await otpService.requestOtp({
    identifier: phone,
    principal,
    purpose,
    ipAddress: req.ip,
  });

  return sendSuccess(res, {
    statusCode: HTTP_STATUS.ACCEPTED,
    message: 'Verification code sent',
    data: result,
  });
};

/** POST /api/v1/auth/otp/verify */
export const verifyOtp = async (req, res) => {
  const { phone, principal, purpose, code } = req.validated.body;

  const result = await authService.authenticateWithOtp({
    phone,
    principal,
    purpose,
    code,
    context: deviceContext(req),
  });

  return sendSuccess(res, { message: 'Signed in successfully', data: result });
};

/** POST /api/v1/auth/refresh */
export const refresh = async (req, res) => {
  const result = await authService.refresh({
    refreshToken: req.validated.body.refreshToken,
    context: {
      ipAddress: req.ip,
      userAgent: req.get('user-agent')?.slice(0, 512),
    },
  });

  return sendSuccess(res, { message: 'Token refreshed successfully', data: result });
};

/** POST /api/v1/auth/logout - ends the calling session only. */
export const logout = async (req, res) => {
  const result = await authService.logout({
    sessionId: req.auth.sessionId,
    userId: req.auth.userId,
  });

  return sendSuccess(res, { message: 'Logged out successfully', data: result });
};

/** POST /api/v1/auth/logout-all - ends every session including this one. */
export const logoutAll = async (req, res) => {
  const result = await authService.logoutAll({ userId: req.auth.userId });

  return sendSuccess(res, { message: 'Logged out of all devices', data: result });
};

/** GET /api/v1/auth/me */
export const me = async (req, res) => {
  const result = await authService.getCurrentUser(req.auth.userId);

  return sendSuccess(res, { message: 'Current user retrieved', data: result });
};
