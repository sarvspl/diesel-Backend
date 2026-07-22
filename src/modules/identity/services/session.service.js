import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { SESSION_REVOCATION_REASON } from '../../../shared/constants/identity.js';
import { NotFoundError, UnauthorizedError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import { uuidv7 } from '../../../shared/utils/uuid.js';
import * as sessionRepository from '../repositories/session.repository.js';

import {
  hashRefreshToken,
  refreshTokenExpiryDate,
  sessionAbsoluteExpiryDate,
  signRefreshToken,
} from './token.service.js';

const log = createLogger({ module: 'identity.session' });

/**
 * Device session lifecycle.
 *
 * One row per logged-in device. Multiple concurrent sessions are supported and
 * listable, so a user who sees an unfamiliar device can revoke just that one.
 *
 * TWO expiry clocks, and the distinction matters:
 *
 *   expiresAt          sliding - pushed out on every rotation, so an active
 *                                user is never signed out mid-use.
 *   absoluteExpiresAt  fixed   - set at login, never extended.
 *
 * The sliding window alone means a session lives forever as long as something
 * keeps refreshing it, which includes an attacker holding a stolen token. The
 * absolute ceiling is what eventually forces re-authentication regardless.
 */

/**
 * Open a session and mint its first refresh token.
 *
 * The session id is generated up front so the token can embed it and the row
 * can store that token's hash - one insert, no placeholder value.
 */
export const startSession = async ({
  userId,
  deviceId,
  deviceName,
  platform,
  appVersion,
  userAgent,
  ipAddress,
}) => {
  const sessionId = uuidv7();
  const refreshToken = signRefreshToken({ userId, sessionId });

  const session = await sessionRepository.create({
    id: sessionId,
    userId,
    refreshTokenHash: hashRefreshToken(refreshToken),
    expiresAt: refreshTokenExpiryDate(),
    absoluteExpiresAt: sessionAbsoluteExpiryDate(),
    deviceId,
    deviceName,
    platform,
    appVersion,
    userAgent,
    ipAddress,
  });

  return { session, refreshToken };
};

/**
 * Rotate a refresh token, with reuse detection.
 *
 * This is the security-critical path in the whole module (BR-122, BR-123).
 *
 * The token proves, by signature, that it was issued for this session. So if
 * the signature is valid but the hash does not match the one stored, the token
 * is a SUPERSEDED one from this same session - which means a token that should
 * have been discarded after rotation is being replayed. The benign explanation
 * (a client retrying with a stale token) and the hostile one (a stolen token
 * used after the victim already refreshed) are indistinguishable from here, so
 * it is treated as theft: the session is revoked and the holder must
 * re-authenticate.
 *
 * Storing only the current hash is what makes this work with a single row -
 * no token-family table is required.
 */
export const rotateSession = async ({
  sessionId,
  presentedToken,
  userId,
  ipAddress,
  userAgent,
}) => {
  const session = await sessionRepository.findByIdForRefresh(sessionId);

  // Same error whether the session is absent or belongs to someone else:
  // distinguishing them would confirm that a session id exists.
  if (!session || session.userId !== userId) {
    throw new UnauthorizedError('Session not found', { code: ERROR_CODES.SESSION_NOT_FOUND });
  }

  if (session.revokedAt) {
    throw new UnauthorizedError('Session has been revoked', {
      code: ERROR_CODES.SESSION_REVOKED,
    });
  }

  const now = new Date();

  // The hard ceiling is checked FIRST and cannot be refreshed past.
  if (session.absoluteExpiresAt <= now) {
    await sessionRepository.revokeById({
      id: session.id,
      reason: SESSION_REVOCATION_REASON.EXPIRED,
    });

    throw new UnauthorizedError('Session has reached its maximum lifetime, please sign in again', {
      code: ERROR_CODES.SESSION_EXPIRED,
    });
  }

  if (session.expiresAt <= now) {
    throw new UnauthorizedError('Session has expired', { code: ERROR_CODES.SESSION_EXPIRED });
  }

  const presentedHash = hashRefreshToken(presentedToken);

  if (presentedHash !== session.refreshTokenHash) {
    await sessionRepository.revokeById({
      id: session.id,
      reason: SESSION_REVOCATION_REASON.TOKEN_REUSE_DETECTED,
    });

    log.warn(
      { sessionId: session.id, userId, rotationCounter: session.rotationCounter },
      'refresh token reuse detected - session revoked'
    );

    throw new UnauthorizedError('Refresh token has already been used', {
      code: ERROR_CODES.TOKEN_REUSE_DETECTED,
    });
  }

  const nextToken = signRefreshToken({ userId, sessionId: session.id });

  /**
   * The sliding window never outlives the ceiling. Without this clamp, a
   * refresh on day 89 of a 90-day session would write an expiry 30 days beyond
   * the ceiling, and the ceiling would only be noticed on the NEXT refresh.
   */
  const slidingExpiry = refreshTokenExpiryDate(now);
  const expiresAt =
    slidingExpiry > session.absoluteExpiresAt ? session.absoluteExpiresAt : slidingExpiry;

  // Conditional update: if a concurrent request rotated first, this affects
  // zero rows and we must not issue a second valid token for the same step.
  const updated = await sessionRepository.rotate({
    id: session.id,
    expectedHash: presentedHash,
    nextHash: hashRefreshToken(nextToken),
    expiresAt,
    ipAddress,
    userAgent,
  });

  if (updated === 0) {
    throw new UnauthorizedError('Refresh token has already been used', {
      code: ERROR_CODES.TOKEN_REUSE_DETECTED,
    });
  }

  return { sessionId: session.id, refreshToken: nextToken };
};

export const listSessions = async (userId) => sessionRepository.listActiveForUser(userId);

/**
 * Revoke one session belonging to the caller.
 *
 * Idempotent: revoking an already-revoked session succeeds, because the
 * caller's intent - "this device must stop working" - is already satisfied.
 * Erroring on a repeated request only breaks retries. (The previous version
 * returned 403 here, which was wrong on both counts.)
 *
 * Scoped to `userId` in the QUERY, so no request can reach another user's
 * session regardless of the id supplied (BR-225). A session belonging to
 * someone else is indistinguishable from one that does not exist: 404, never
 * 403 (docs/10 §6).
 */
export const revokeSession = async ({
  sessionId,
  userId,
  reason = SESSION_REVOCATION_REASON.DEVICE_REVOKED,
}) => {
  const session = await sessionRepository.findByIdForUser({ id: sessionId, userId });

  if (!session) {
    throw new NotFoundError('Session not found', { code: ERROR_CODES.SESSION_NOT_FOUND });
  }

  const revokedCount = await sessionRepository.revokeById({ id: sessionId, reason });

  return { id: sessionId, revoked: revokedCount > 0, alreadyRevoked: revokedCount === 0 };
};

export const revokeAllSessions = async ({
  userId,
  reason = SESSION_REVOCATION_REASON.LOGOUT_ALL,
  exceptSessionId,
}) => {
  const revokedCount = await sessionRepository.revokeAllForUser({
    userId,
    reason,
    exceptSessionId,
  });

  log.info({ userId, revokedCount, reason }, 'sessions revoked');

  return { revokedCount };
};

/**
 * Delete sessions that can no longer be used.
 *
 * Sessions are operational data, not a business record: once dead they answer
 * no question worth the storage (docs/08 §1.6, §11). Without this the table
 * grows without bound - one row per login, forever.
 *
 * Intended for a scheduled job. Deliberately NOT wired to a scheduler: there is
 * no job runner in this phase, and a self-scheduling timer inside the API
 * process would run once per instance and is exactly the in-memory state
 * docs/01 §7.2 forbids.
 *
 * @param {object} [options]
 * @param {number} [options.retainDays] Grace period, so a recently expired
 *   session can still be explained during a support call.
 */
export const purgeDeadSessions = async ({ retainDays = 30 } = {}) => {
  const before = new Date(Date.now() - retainDays * 86_400 * 1_000);
  const deleted = await sessionRepository.deleteDeadSessions(before);

  log.info({ deleted, retainDays }, 'dead sessions purged');

  return { deleted };
};
