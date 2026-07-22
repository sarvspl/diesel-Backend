import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Idempotency records (BR-803, ADR-013).
 *
 * PLATFORM-OWNED and deliberately ignorant of business concepts: this file
 * knows about users, endpoints and opaque response bodies, and nothing about
 * orders. docs/06 §17 is explicit - "if something here knows what an order is,
 * it is in the wrong context".
 */

const FIELDS = {
  id: true,
  key: true,
  userId: true,
  endpoint: true,
  requestHash: true,
  state: true,
  responseStatus: true,
  responseBody: true,
  resourceId: true,
  expiresAt: true,
  createdAt: true,
};

/**
 * Claim a key, or report that it is already claimed.
 *
 * THE RACE THIS RESOLVES: two taps arrive in the same millisecond. Both read
 * "no such key". Both proceed. Two orders.
 *
 * So this does not read-then-write. It attempts the INSERT and lets the unique
 * constraint arbitrate - exactly one transaction can win, and the loser learns
 * it lost from the constraint violation rather than from a check that was
 * already stale when it ran (docs/08 §9.4: "a constraint violation is a correct
 * outcome here, not an error to be logged and ignored").
 *
 * @returns {Promise<{ claimed: boolean, record: object }>}
 *   claimed=true  -> this caller owns the operation and must execute it
 *   claimed=false -> `record` is the existing one: replay it, or reject it
 */
export const claim = async ({ key, userId, endpoint, requestHash, expiresAt }) => {
  try {
    const record = await prisma.idempotencyKey.create({
      data: { key, userId, endpoint, requestHash, expiresAt },
      select: FIELDS,
    });

    return { claimed: true, record };
  } catch (error) {
    // P2002: unique constraint. Anything else is a real failure and propagates.
    if (error?.code !== 'P2002') throw error;

    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_endpoint_key: { userId, endpoint, key } },
      select: FIELDS,
    });

    // Vanishingly rare: the winner's row was pruned between the violation and
    // this read. Treat it as claimable rather than crashing.
    if (!existing) return claim({ key, userId, endpoint, requestHash, expiresAt });

    return { claimed: false, record: existing };
  }
};

/** Store the response so a replay returns the first answer, not a second one. */
export const complete = async ({ id, responseStatus, responseBody, resourceId }) =>
  prisma.idempotencyKey.update({
    where: { id },
    data: {
      state: 'COMPLETED',
      responseStatus,
      responseBody,
      resourceId: resourceId ?? null,
    },
    select: FIELDS,
  });

/**
 * Drop a claim whose operation failed.
 *
 * Deliberate: a 500 must be RETRYABLE with the same key. Leaving the row
 * IN_PROGRESS would lock the customer out of their own order for the whole
 * retention window over a transient database blip.
 *
 * A failure that is the client's fault (a 4xx) is NOT released - it is stored
 * like any other response, because replaying it returns the same clean error
 * rather than re-running validation.
 */
export const release = async (id) => {
  await prisma.idempotencyKey.deleteMany({ where: { id, state: 'IN_PROGRESS' } });
};

/** Retention sweep (docs/08 §11). No scheduler yet; exercised by tests. */
export const deleteExpired = async (before = new Date()) => {
  const { count } = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: before } },
  });

  return count;
};
