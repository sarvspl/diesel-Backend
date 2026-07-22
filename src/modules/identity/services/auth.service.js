import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { OTP_PURPOSE, SESSION_REVOCATION_REASON } from '../../../shared/constants/identity.js';
import { DEFAULT_ROLE_BY_PRINCIPAL, PRINCIPALS } from '../../../shared/constants/rbac.js';
import { ConflictError, NotFoundError, UnauthorizedError } from '../../../shared/errors/index.js';
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
 * Register a new platform identity.
 *
 * Deliberately restricted to CUSTOMER. Drivers are created by an administrator
 * (BR-301) and administrators are created by other administrators (docs/03 §1),
 * so a public endpoint must not be able to mint either. Those paths belong to
 * their own modules and are not part of this phase.
 *
 * NOTE on enumeration: a duplicate registration necessarily returns a conflict,
 * which reveals that an account exists for that identifier. The proper fix is
 * verification-first registration - accept the request, send an OTP, and only
 * then create the identity - which needs the `otp_challenges` table that this
 * phase does not create. Until then the exposure is limited by the strict rate
 * limit on this route, and the error deliberately does not say WHICH of phone
 * or email collided.
 */
export const register = async ({ phone, email, password, consentVersion, context }) => {
  const principal = PRINCIPALS.CUSTOMER;

  const existing = await userRepository.findByIdentifierForAuth({
    principal,
    ...(phone ? { phone } : { email }),
  });

  if (existing) {
    throw new ConflictError('An account with these details already exists', {
      code: ERROR_CODES.ACCOUNT_ALREADY_EXISTS,
    });
  }

  const passwordHash = password ? await hashPassword(password) : null;

  const user = await userRepository.createWithRole({
    principal,
    phone,
    email,
    passwordHash,
    consentVersion,
    roleCode: DEFAULT_ROLE_BY_PRINCIPAL[principal],
  });

  const { session, refreshToken } = await startSession({ userId: user.id, ...context });

  log.info({ userId: user.id, principal }, 'identity registered');

  return issueTokens({ user, sessionId: session.id, refreshToken });
};

/**
 * Authenticate with a password.
 *
 * Per BR-101 customers and drivers are intended to authenticate by OTP; this
 * password path is what administrators use, and is the foundation the OTP flow
 * will reuse once it can persist challenges.
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
 * This is the flow BR-101 actually specifies for customers and drivers - "no
 * password is required for the customer app". The password path above is what
 * administrators use.
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

  const user = await userRepository.findByIdWithRoles(payload.sub);

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
  const user = await userRepository.findByIdWithRoles(userId);

  if (!user) {
    throw new NotFoundError('User not found');
  }

  const { roles, permissions } = flattenAuthorisation(user);

  return { user: toPublicUser(user), roles, permissions };
};
