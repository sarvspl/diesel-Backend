import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Data access for OTP challenges.
 *
 * Never returns `codeHash` outside `findLive`, which is the only caller that
 * needs to compare against it.
 */

/**
 * The one live challenge for this identifier/principal/purpose, if any.
 *
 * "Live" means not consumed and not expired. Ordered newest-first as a
 * belt-and-braces measure: the service invalidates the previous challenge on
 * every resend, so at most one should match, but if that invariant were ever
 * broken the newest code is the correct one to honour.
 */
export const findLive = async ({ identifier, principal, purpose }) =>
  prisma.otpChallenge.findFirst({
    where: {
      identifier,
      principal,
      purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      codeHash: true,
      attempts: true,
      maxAttempts: true,
      resendCount: true,
      expiresAt: true,
      createdAt: true,
    },
  });

export const create = async ({
  identifier,
  principal,
  purpose,
  codeHash,
  expiresAt,
  maxAttempts,
  resendCount,
  ipAddress,
}) =>
  prisma.otpChallenge.create({
    data: {
      identifier,
      principal,
      purpose,
      codeHash,
      expiresAt,
      maxAttempts,
      resendCount,
      ipAddress: ipAddress ?? null,
    },
    select: { id: true, expiresAt: true, resendCount: true, createdAt: true },
  });

/**
 * Mark a challenge as spent.
 *
 * Conditional on it still being unconsumed, so two concurrent verifications of
 * the same code cannot both succeed - the loser gets zero rows and is treated
 * as an invalid code. Single-use has to be enforced here, not by a prior read
 * (docs/08 §9.3).
 *
 * @returns {Promise<number>} 1 if this caller consumed it, 0 if it lost.
 */
export const consume = async (id) => {
  const { count } = await prisma.otpChallenge.updateMany({
    where: { id, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  return count;
};

/** Invalidate every live challenge for a target - used when resending. */
export const consumeAllLive = async ({ identifier, principal, purpose }) => {
  const { count } = await prisma.otpChallenge.updateMany({
    where: { identifier, principal, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  return count;
};

/**
 * Record a failed attempt and report whether the budget is now exhausted.
 *
 * Incremented atomically in the database rather than read-modify-written in
 * the service: parallel guesses against the same challenge would otherwise
 * each read the same count and the limit would never be reached.
 */
export const registerFailedAttempt = async (id) => {
  const updated = await prisma.otpChallenge.update({
    where: { id },
    data: { attempts: { increment: 1 } },
    select: { attempts: true, maxAttempts: true },
  });

  return {
    attempts: updated.attempts,
    exhausted: updated.attempts >= updated.maxAttempts,
  };
};

/**
 * How many codes were issued to this target inside the window.
 *
 * The counter for per-identifier send limits (BR-113). Counting rows is why
 * challenges are append-only rather than updated in place on resend.
 */
export const countSince = async ({ identifier, principal, since }) =>
  prisma.otpChallenge.count({
    where: { identifier, principal, createdAt: { gte: since } },
  });

/**
 * How many codes were requested from this IP inside the window.
 *
 * Independent of the per-identifier limit and not optional: without it an
 * attacker rotates identifiers to run up the operator's SMS bill, which is a
 * common and directly expensive attack (BR-114).
 */
export const countByIpSince = async ({ ipAddress, since }) =>
  prisma.otpChallenge.count({
    where: { ipAddress, createdAt: { gte: since } },
  });

/** Remove spent and expired challenges past their retention window. */
export const deleteSpent = async (before) => {
  const { count } = await prisma.otpChallenge.deleteMany({
    where: {
      OR: [{ consumedAt: { lt: before } }, { expiresAt: { lt: before } }],
    },
  });

  return count;
};
