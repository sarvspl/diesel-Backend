import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Data access for device sessions.
 *
 * A session row never contains a usable credential: only the SHA-256 of the
 * current refresh token (BR-121).
 */

/** Safe to return to the session-list endpoint. Note: no token hash. */
const PUBLIC_FIELDS = {
  id: true,
  deviceId: true,
  deviceName: true,
  platform: true,
  appVersion: true,
  userAgent: true,
  ipAddress: true,
  isTrusted: true,
  issuedAt: true,
  lastUsedAt: true,
  expiresAt: true,
  absoluteExpiresAt: true,
  revokedAt: true,
  revokedReason: true,
  createdAt: true,
};

/**
 * `id` is supplied by the caller rather than defaulted, because the refresh
 * token has to embed the session id and the row has to store that token's hash.
 * Generating the id first breaks the circular dependency.
 */
export const create = async ({
  id,
  userId,
  refreshTokenHash,
  expiresAt,
  absoluteExpiresAt,
  deviceId,
  deviceName,
  platform,
  appVersion,
  userAgent,
  ipAddress,
}) =>
  prisma.userSession.create({
    data: {
      id,
      userId,
      refreshTokenHash,
      expiresAt,
      absoluteExpiresAt,
      deviceId: deviceId ?? null,
      deviceName: deviceName ?? null,
      // `isTrusted` is intentionally absent: it defaults to false and must
      // never be settable from a request payload.
      platform: platform ?? 'UNKNOWN',
      appVersion: appVersion ?? null,
      userAgent: userAgent ?? null,
      ipAddress: ipAddress ?? null,
    },
    select: { ...PUBLIC_FIELDS, userId: true, rotationCounter: true },
  });

/** Includes the hash and both expiry clocks: the refresh flow needs all three. */
export const findByIdForRefresh = async (id) =>
  prisma.userSession.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      refreshTokenHash: true,
      rotationCounter: true,
      expiresAt: true,
      absoluteExpiresAt: true,
      revokedAt: true,
      revokedReason: true,
    },
  });

export const findByIdForUser = async ({ id, userId }) =>
  prisma.userSession.findFirst({ where: { id, userId }, select: PUBLIC_FIELDS });

/** Live sessions only: not revoked, and inside BOTH expiry clocks. */
export const listActiveForUser = async (userId) => {
  const now = new Date();

  return prisma.userSession.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: now },
      absoluteExpiresAt: { gt: now },
    },
    select: PUBLIC_FIELDS,
    orderBy: { lastUsedAt: 'desc' },
  });
};

/**
 * Swap in a new token hash as part of rotation.
 *
 * Conditional on the session still being live and still holding the hash we
 * read: `updateMany` returning zero rows means another request rotated it
 * first, and the caller treats that as a replay rather than retrying. This is
 * the conditional-claim pattern from docs/08 §9.3, applied to refresh.
 *
 * `absoluteExpiresAt` is deliberately NOT updatable here - extending it would
 * defeat the ceiling it exists to impose.
 *
 * @returns {Promise<number>} rows updated - 1 on success, 0 if it lost the race
 */
export const rotate = async ({ id, expectedHash, nextHash, expiresAt, ipAddress, userAgent }) => {
  const { count } = await prisma.userSession.updateMany({
    where: { id, refreshTokenHash: expectedHash, revokedAt: null },
    data: {
      refreshTokenHash: nextHash,
      rotationCounter: { increment: 1 },
      lastUsedAt: new Date(),
      expiresAt,
      ipAddress: ipAddress ?? undefined,
      userAgent: userAgent ?? undefined,
    },
  });

  return count;
};

export const revokeById = async ({ id, reason }) => {
  const { count } = await prisma.userSession.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });

  return count;
};

/**
 * Revoke every live session for a user.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.reason
 * @param {string} [params.exceptSessionId] Keep the caller's own session alive.
 */
export const revokeAllForUser = async ({ userId, reason, exceptSessionId }) => {
  const { count } = await prisma.userSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
    data: { revokedAt: new Date(), revokedReason: reason },
  });

  return count;
};

/**
 * Hard-delete sessions that are dead and past their retention window.
 *
 * Hard delete, not soft: a session is operational machinery, and a revoked row
 * from two years ago answers no question worth its storage (docs/08 §5).
 *
 * @param {Date} before Only remove rows that became dead before this instant.
 */
export const deleteDeadSessions = async (before) => {
  const { count } = await prisma.userSession.deleteMany({
    where: {
      OR: [
        { revokedAt: { lt: before } },
        { expiresAt: { lt: before } },
        { absoluteExpiresAt: { lt: before } },
      ],
    },
  });

  return count;
};
