import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Outbox rows (ADR-012).
 *
 * Every write here takes a transaction client. That is not a convenience - it
 * is the entire mechanism. An outbox row written outside the transaction that
 * changed the state reintroduces both failure modes the pattern exists to
 * prevent: state committed with the side effect lost, or the side effect fired
 * against a transaction that rolled back.
 */

const FIELDS = {
  id: true,
  aggregate: true,
  aggregateId: true,
  eventType: true,
  payload: true,
  status: true,
  attempts: true,
  nextRetryAt: true,
  processedAt: true,
  createdAt: true,
};

/**
 * Append one event.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx REQUIRED.
 */
export const append = async (tx, { aggregate, aggregateId, eventType, payload }) =>
  tx.outboxEvent.create({
    data: { aggregate, aggregateId, eventType, payload },
    select: FIELDS,
  });

/** Append several in one go, for a transition that fans out. */
export const appendMany = async (tx, events) =>
  tx.outboxEvent.createMany({
    data: events.map(({ aggregate, aggregateId, eventType, payload }) => ({
      aggregate,
      aggregateId,
      eventType,
      payload,
    })),
  });

/** Read back an aggregate's events. Used by tests and the support timeline. */
export const listForAggregate = async ({ aggregate, aggregateId }) =>
  prisma.outboxEvent.findMany({
    where: { aggregate, aggregateId },
    select: FIELDS,
    orderBy: { createdAt: 'asc' },
  });

/**
 * The drainer's read: pending rows whose retry time has come.
 *
 * No drainer exists yet. This is here so the eventual worker has a query that
 * matches the partial index rather than inventing one that does not.
 */
export const claimPending = async ({ limit = 50, now = new Date() } = {}) =>
  prisma.outboxEvent.findMany({
    where: {
      status: { in: ['PENDING', 'FAILED'] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    select: FIELDS,
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
