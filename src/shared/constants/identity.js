/**
 * JavaScript mirrors of the Prisma enums.
 *
 * Without these, enum values reach the database as bare string literals
 * (`'TOKEN_REUSE_DETECTED'`) scattered through services. A typo in one then
 * fails at runtime, on the security path, only when that branch executes -
 * which for reuse detection means only when someone is actually being
 * attacked. There is no compiler here to catch it, so the constant is the
 * substitute.
 *
 * These MUST stay in step with prisma/schema.prisma. A test asserts they do.
 */

/** @see SessionRevocationReason in the Prisma schema */
export const SESSION_REVOCATION_REASON = Object.freeze({
  LOGOUT: 'LOGOUT',
  LOGOUT_ALL: 'LOGOUT_ALL',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',
  ADMIN_REVOKED: 'ADMIN_REVOKED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  EXPIRED: 'EXPIRED',
});

/** @see UserStatus in the Prisma schema */
export const USER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  BLOCKED: 'BLOCKED',
  DELETED: 'DELETED',
});

/** @see DevicePlatform in the Prisma schema */
export const DEVICE_PLATFORM = Object.freeze({
  ANDROID: 'ANDROID',
  IOS: 'IOS',
  WEB: 'WEB',
  UNKNOWN: 'UNKNOWN',
});

/** @see OtpPurpose in the Prisma schema */
export const OTP_PURPOSE = Object.freeze({
  LOGIN: 'LOGIN',
  SIGNUP: 'SIGNUP',
  PHONE_VERIFICATION: 'PHONE_VERIFICATION',
  EMAIL_VERIFICATION: 'EMAIL_VERIFICATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PHONE_CHANGE: 'PHONE_CHANGE',
});

/**
 * Purposes a client may request through the public OTP endpoint.
 *
 * PHONE_CHANGE is deliberately excluded: its flow does not exist yet, and
 * exposing it now would let a caller obtain a code for an operation nothing
 * verifies. PASSWORD_RESET is verified by POST /auth/password/reset.
 */
export const PUBLIC_OTP_PURPOSES = Object.freeze([
  OTP_PURPOSE.LOGIN,
  OTP_PURPOSE.SIGNUP,
  OTP_PURPOSE.PHONE_VERIFICATION,
  OTP_PURPOSE.PASSWORD_RESET,
]);

/**
 * Purposes POST /auth/otp/verify accepts. PASSWORD_RESET is spent only by the
 * reset endpoint, so a reset code cannot double as a plain sign-in code.
 */
export const SIGN_IN_OTP_PURPOSES = Object.freeze([
  OTP_PURPOSE.LOGIN,
  OTP_PURPOSE.SIGNUP,
  OTP_PURPOSE.PHONE_VERIFICATION,
]);
