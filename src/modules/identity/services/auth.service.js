import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { OTP_PURPOSE, SESSION_REVOCATION_REASON } from '../../../shared/constants/identity.js';
import { DEFAULT_ROLE_BY_PRINCIPAL, PRINCIPALS } from '../../../shared/constants/rbac.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
} from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as sessionRepository from '../repositories/session.repository.js';
import * as userRepository from '../repositories/user.repository.js';
import { flattenAuthorisation } from '../repositories/user.repository.js';

import { evaluateAccountGates } from './account-gate.js';
import { verifyOtp } from './otp.service.js';
import { burnPasswordTiming, hashPassword, verifyPassword } from './password.service.js';
import { revokeAllSessions, rotateSession, startSession } from './session.service.js';
import { signAccessToken, verifyRefreshToken } from './token.service.js';

const log = createLogger({ module: 'identity.auth' });

/**
 * Authentication orchestration.
 *
 * Knows nothing about HTTP: no `req`, no `res`, no status codes. Everything
 * here could be driven from a CLI or a background job unchanged (docs/11 §1.3).
 */

/** Shape returned to the client. Never includes a password hash. */
const toPublicUser = (user) => ({
  id: user.id,
  principal: user.principal,
  phone: user.phone,
  email: user.email,
  status: user.status,
  phoneVerified: Boolean(user.phoneVerifiedAt),
  emailVerified: Boolean(user.emailVerifiedAt),
  /**
   * Whether mobile/email + password sign-in is possible, so an app can offer
   * "Set password" or "Change password". Derived from the hash, never the hash.
   * Every caller passes a row selected WITH the hash for this to be accurate.
   */
  hasPassword: Boolean(user.passwordHash),
  createdAt: user.createdAt,
});

/**
 * Reject anyone whose account is not usable.
 *
 * Separate from credential checking so it runs identically on login and on
 * refresh (BR-125) - an account blocked mid-session loses access at its next
 * refresh rather than whenever its access token happens to lapse.
 */
const assertUsableAccount = async (user) => {
  if (user.status === 'BLOCKED') {
    throw new UnauthorizedError('This account has been blocked', {
      code: ERROR_CODES.ACCOUNT_BLOCKED,
    });
  }

  if (user.status === 'DELETED') {
    throw new UnauthorizedError('This account no longer exists', {
      code: ERROR_CODES.ACCOUNT_DELETED,
    });
  }

  /**
   * Gates contributed by other modules - currently the corporate one, which
   * blocks a member whose company is not APPROVED + ACTIVE (BR-203, BR-209).
   *
   * Identity does not know what those gates check. It only enforces the answer.
   * See account-gate.js for why the dependency runs this way round.
   */
  const denial = await evaluateAccountGates(user);

  if (denial) {
    throw new UnauthorizedError(denial.message, { code: denial.code });
  }
};

/** Build the token pair for an already-authenticated user. */
const issueTokens = async ({ user, sessionId, refreshToken }) => {
  const { roles, permissions } = flattenAuthorisation(user);

  const accessToken = signAccessToken({
    userId: user.id,
    principal: user.principal,
    sessionId,
    roles,
    permissions,
  });

  return {
    user: toPublicUser(user),
    roles,
    permissions,
    tokens: { accessToken, refreshToken },
  };
};

/**
 * Customer sign-up with a password (mobile verified by OTP in the same call).
 *
 * Deliberately restricted to CUSTOMER. Drivers are created by an administrator
 * (BR-301) and administrators are created by other administrators (docs/03 §1),
 * so a public endpoint must not be able to mint either.
 *
 * VERIFICATION-FIRST. The SIGNUP code is checked before anything else, so the
 * conflict answers below are only ever given to someone who controls the
 * number - which removes the enumeration the old unverified register allowed,
 * and means no account can hold a mobile number its owner did not prove. An
 * email conflict is still disclosed to that verified caller; it is bounded by
 * the per-number OTP send limits.
 *
 * The account can then sign in with mobile + OTP, or mobile/email + password.
 */
export const register = async ({ phone, code, email, password, consentVersion, context }) => {
  const principal = PRINCIPALS.CUSTOMER;

  await verifyOtp({ identifier: phone, principal, purpose: OTP_PURPOSE.SIGNUP, code });

  if (await userRepository.findByIdentifierForAuth({ principal, phone })) {
    throw new ConflictError('An account already exists for this mobile number. Please sign in.', {
      code: ERROR_CODES.ACCOUNT_ALREADY_EXISTS,
      details: { field: 'phone' },
    });
  }

  if (email && (await userRepository.findByIdentifierForAuth({ principal, email }))) {
    throw new ConflictError('This email is already used by another account', {
      code: ERROR_CODES.ACCOUNT_ALREADY_EXISTS,
      details: { field: 'email' },
    });
  }

  const passwordHash = await hashPassword(password);

  const user = await userRepository.createWithRole({
    principal,
    phone,
    email,
    passwordHash,
    consentVersion,
    roleCode: DEFAULT_ROLE_BY_PRINCIPAL[principal],
    phoneVerified: true,
  });

  const { session, refreshToken } = await startSession({ userId: user.id, ...context });
  await userRepository.touchLastLogin(user.id);

  log.info({ userId: user.id, principal }, 'identity registered with password');

  return issueTokens({ user: { ...user, passwordHash }, sessionId: session.id, refreshToken });
};

/**
 * Authenticate with a password.
 *
 * Every principal may use it: administrators always, customers and drivers
 * as the alternative to OTP, by mobile OR email. It succeeds only for accounts
 * that have a password (set at sign-up, by an admin at driver onboarding, or
 * via set/reset password).
 *
 * Every failure returns the SAME error - INVALID_CREDENTIALS - whether the
 * account is unknown, has no password set, or the password is wrong. The
 * unknown-account branch also burns equivalent CPU time, because a fast
 * rejection is as good a signal as a distinct message.
 */
export const login = async ({ principal, phone, email, password, context }) => {
  const user = await userRepository.findByIdentifierForAuth({
    principal,
    ...(phone ? { phone } : { email }),
  });

  if (!user) {
    await burnPasswordTiming(password);
    throw new UnauthorizedError('Invalid credentials', {
      code: ERROR_CODES.INVALID_CREDENTIALS,
    });
  }

  const passwordMatches = await verifyPassword(user.passwordHash, password);

  if (!passwordMatches) {
    log.warn({ userId: user.id, principal }, 'failed login attempt');
    throw new UnauthorizedError('Invalid credentials', {
      code: ERROR_CODES.INVALID_CREDENTIALS,
    });
  }

  // Status is checked only AFTER credentials verify. Checking first would let
  // an attacker distinguish "blocked account" from "no such account" without
  // knowing any password.
  await assertUsableAccount(user);

  const { session, refreshToken } = await startSession({ userId: user.id, ...context });
  await userRepository.touchLastLogin(user.id);

  log.info({ userId: user.id, sessionId: session.id, principal }, 'login succeeded');

  return issueTokens({ user, sessionId: session.id, refreshToken });
};

/**
 * Authenticate with a one-time code.
 *
 * The passwordless path for customers and drivers (BR-101). Accounts that
 * also have a password can use either.
 *
 * SIGNUP creates the identity on first successful verification, so there is no
 * separate registration step and therefore nothing to enumerate: an unknown
 * number and a known one are indistinguishable until a valid code is supplied,
 * and by then the caller controls the number anyway.
 *
 * Drivers may LOGIN but never SIGNUP - driver accounts are created by an
 * administrator (BR-301).
 */
export const authenticateWithOtp = async ({ phone, principal, purpose, code, context }) => {
  await verifyOtp({ identifier: phone, principal, purpose, code });

  let user = await userRepository.findByIdentifierForAuth({ principal, phone });

  if (!user) {
    if (purpose !== OTP_PURPOSE.SIGNUP || principal !== PRINCIPALS.CUSTOMER) {
      // A driver or admin number with no account, or a LOGIN for an unknown
      // number. The code was valid, so the caller owns the number - but no
      // account exists and this flow must not create one.
      throw new UnauthorizedError('No account exists for this number', {
        code: ERROR_CODES.INVALID_CREDENTIALS,
      });
    }

    user = await userRepository.createWithRole({
      principal,
      phone,
      roleCode: DEFAULT_ROLE_BY_PRINCIPAL[principal],
      // The code proved control of the number, which is precisely what
      // verification means.
      phoneVerified: true,
    });

    log.info({ userId: user.id, principal }, 'identity created via OTP signup');
  } else {
    await userRepository.markPhoneVerified(user.id);
  }

  await assertUsableAccount(user);

  const { session, refreshToken } = await startSession({ userId: user.id, ...context });
  await userRepository.touchLastLogin(user.id);

  log.info({ userId: user.id, sessionId: session.id, principal }, 'OTP login succeeded');

  return issueTokens({ user, sessionId: session.id, refreshToken });
};

/**
 * Exchange a refresh token for a new pair, rotating it.
 *
 * Re-reads the user so roles, permissions and account status in the new access
 * token are current rather than copied from the old one (BR-125).
 */
export const refresh = async ({ refreshToken, context }) => {
  const payload = verifyRefreshToken(refreshToken);

  const user = await userRepository.findByIdForAuth(payload.sub);

  if (!user) {
    throw new UnauthorizedError('Invalid credentials', {
      code: ERROR_CODES.INVALID_CREDENTIALS,
    });
  }

  await assertUsableAccount(user);

  const { sessionId, refreshToken: nextRefreshToken } = await rotateSession({
    sessionId: payload.sid,
    presentedToken: refreshToken,
    userId: user.id,
    ipAddress: context?.ipAddress,
    userAgent: context?.userAgent,
  });

  return issueTokens({ user, sessionId, refreshToken: nextRefreshToken });
};

/**
 * End the calling session only. Other devices stay logged in.
 *
 * Idempotent by design: revoking an already-revoked session still returns
 * success, because the caller's intent - "this session must stop working" - is
 * satisfied either way. A client retrying after a dropped response should not
 * see an error for something that already happened.
 *
 * The access token itself remains cryptographically valid until it expires;
 * what stops here is the ability to obtain a new one. That window is the
 * documented cost of stateless access tokens (token.service.js).
 */
export const logout = async ({ sessionId, userId }) => {
  const revokedCount = await sessionRepository.revokeById({
    id: sessionId,
    reason: SESSION_REVOCATION_REASON.LOGOUT,
  });

  log.info({ userId, sessionId, revokedCount }, 'logout');

  return { sessionId, revoked: revokedCount > 0 };
};

/** End every session for the user, including the calling one. */
export const logoutAll = async ({ userId }) => revokeAllSessions({ userId, reason: 'LOGOUT_ALL' });

/** The authenticated caller's own identity, roles and permissions. */
export const getCurrentUser = async (userId) => {
  const user = await userRepository.findByIdForAuth(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  const { roles, permissions } = flattenAuthorisation(user);

  return { user: toPublicUser(user), roles, permissions };
};

/**
 * Forgotten password, by mobile + PASSWORD_RESET code.
 *
 * Also the way an OTP-only account gets its first password without signing
 * in. Every existing session is revoked (a reset usually means the old
 * password may be known to someone else) and a fresh one is started, so the
 * caller is signed in on return.
 */
export const resetPassword = async ({ phone, principal, code, newPassword, context }) => {
  await verifyOtp({ identifier: phone, principal, purpose: OTP_PURPOSE.PASSWORD_RESET, code });

  const user = await userRepository.findByIdentifierForAuth({ principal, phone });

  if (!user) {
    throw new UnauthorizedError('No account exists for this number', {
      code: ERROR_CODES.INVALID_CREDENTIALS,
    });
  }

  await assertUsableAccount(user);

  const passwordHash = await hashPassword(newPassword);
  await userRepository.setPasswordHash(user.id, passwordHash);
  await userRepository.markPhoneVerified(user.id);

  await revokeAllSessions({
    userId: user.id,
    reason: SESSION_REVOCATION_REASON.PASSWORD_CHANGED,
  });

  const { session, refreshToken } = await startSession({ userId: user.id, ...context });
  await userRepository.touchLastLogin(user.id);

  log.info({ userId: user.id, principal }, 'password reset via OTP');

  return issueTokens({ user: { ...user, passwordHash }, sessionId: session.id, refreshToken });
};

/**
 * Set (first time) or change the signed-in caller's password.
 *
 * An account that already has a password must present it: a stolen access
 * token alone must not be enough to lock the owner out. An OTP-only account
 * has nothing to present, and its session already proves the number.
 *
 * Other sessions are revoked; the calling one survives.
 */
export const changePassword = async ({ userId, sessionId, currentPassword, newPassword }) => {
  const user = await userRepository.findByIdForAuth(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  if (user.passwordHash) {
    const matches = currentPassword
      ? await verifyPassword(user.passwordHash, currentPassword)
      : false;

    if (!matches) {
      // 400, not 401: the caller IS authenticated, and a 401 would send the
      // apps' interceptors into a pointless token refresh.
      throw new BadRequestError('Current password is incorrect', {
        code: ERROR_CODES.CURRENT_PASSWORD_INCORRECT,
      });
    }
  }

  await userRepository.setPasswordHash(user.id, await hashPassword(newPassword));

  const revoked = await revokeAllSessions({
    userId,
    reason: SESSION_REVOCATION_REASON.PASSWORD_CHANGED,
    exceptSessionId: sessionId,
  });

  log.info({ userId, firstPassword: !user.passwordHash }, 'password set');

  return { hasPassword: true, revokedSessions: revoked?.revokedCount ?? 0 };
};

/**
 * Add, change or remove (null) the caller's email - their alias for password
 * sign-in. Unique per principal, like the phone.
 */
export const updateMe = async ({ userId, email }) => {
  const current = await userRepository.findByIdForAuth(userId);

  if (!current) {
    throw new NotFoundError('User not found');
  }

  if (email && email !== current.email) {
    const taken = await userRepository.findByIdentifierForAuth({
      principal: current.principal,
      email,
    });

    if (taken) {
      throw new ConflictError('This email is already used by another account', {
        code: ERROR_CODES.ACCOUNT_ALREADY_EXISTS,
        details: { field: 'email' },
      });
    }
  }

  const user = email === current.email ? current : await userRepository.updateEmail(userId, email);

  const { roles, permissions } = flattenAuthorisation(user);

  return { user: toPublicUser(user), roles, permissions };
};
