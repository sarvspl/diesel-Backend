import { prisma } from '../../../infrastructure/database/prisma.js';
import { ORDER_NUMBER_PREFIX } from '../../../shared/constants/order.js';

/**
 * Order persistence.
 *
 * Two things here are load-bearing and easy to undo by accident:
 *
 *  1. `ORDER_FIELDS` never selects the snapshot JSON. Snapshots are large and
 *     only the detail view needs them; a list endpoint that drags four JSON
 *     documents per row is how an order list becomes the slowest page in the
 *     admin.
 *
 *  2. There is NO `updateStatus`. Status is written by exactly one function
 *     (`transition-order.service.js`), through `applyTransition` below, which
 *     takes a transaction client and a compare-and-set predicate. Adding a
 *     convenient status setter here is the second write path docs/07 §10.1
 *     exists to forbid.
 */

const ORDER_FIELDS = {
  id: true,
  orderNumber: true,
  userId: true,
  corporateAccountId: true,
  corporateMemberId: true,
  quoteId: true,
  addressId: true,
  productId: true,
  priceId: true,
  quantity: true,
  deliveredQuantity: true,
  fuelAmount: true,
  deliveryAmount: true,
  taxAmount: true,
  totalAmount: true,
  finalTotalAmount: true,
  status: true,
  paymentStatus: true,
  settlementStatus: true,
  paymentMode: true,
  statusChangedAt: true,
  expiresAt: true,
  cancelledAt: true,
  cancelledByUserId: true,
  cancelledByKind: true,
  cancellationReason: true,
  city: true,
  state: true,
  deliveryInstructions: true,
  placedAt: true,
  createdAt: true,
  updatedAt: true,
};

/** The detail projection. Adds the frozen documents. */
const ORDER_DETAIL_FIELDS = {
  ...ORDER_FIELDS,
  customerSnapshot: true,
  addressSnapshot: true,
  productSnapshot: true,
  pricingSnapshot: true,
};

export { ORDER_FIELDS, ORDER_DETAIL_FIELDS };

/**
 * Allocate the next human-readable order number (BR-810).
 *
 * `DFY-2607-000123` - prefix, year and month, then a counter within that month.
 *
 * WHY A SUBQUERY AND NOT A SEQUENCE: a PostgreSQL sequence is deliberately
 * non-transactional, so a rolled-back order would burn a number and leave a
 * permanent gap. That is tolerable for an order and NOT tolerable for an
 * invoice, and having two different mechanisms for two things that look
 * identical is how the invoice one eventually gets "simplified" into the wrong
 * one (docs/11 §2.5, BR-1303).
 *
 * The count is scoped per month, so the number reveals monthly volume at worst
 * rather than lifetime volume - which is the leak ADR-005 objects to.
 *
 * Called INSIDE the creating transaction, and the unique constraint on
 * `order_number` is the backstop: two orders in the same millisecond produce
 * the same count, the second insert fails, and the caller retries.
 */
export const allocateOrderNumber = async (tx, now = new Date()) => {
  const year = String(now.getUTCFullYear()).slice(-2);
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const period = `${year}${month}`;

  const [{ next }] = await tx.$queryRaw`
    SELECT COALESCE(MAX(SUBSTRING(order_number FROM 10)::bigint), 0) + 1 AS next
    FROM orders
    WHERE order_number LIKE ${`${ORDER_NUMBER_PREFIX}-${period}-%`}
  `;

  return `${ORDER_NUMBER_PREFIX}-${period}-${String(next).padStart(6, '0')}`;
};

/** Create the order row. Always called inside the placement transaction. */
export const create = async (tx, data) => tx.order.create({ data, select: ORDER_DETAIL_FIELDS });

export const findById = async (id) =>
  prisma.order.findUnique({ where: { id }, select: ORDER_DETAIL_FIELDS });

/**
 * Scoped read.
 *
 * Authorisation is enforced HERE, in the data-access layer, not only in a
 * controller (docs/11 §7.3): "a missing controller check is one forgotten line
 * from a data breach". There is simply no query in this file that can return
 * another customer's order, so a caller who forgets to check gets a 404 rather
 * than a leak.
 *
 * Corporate scope comes from the caller's memberships, never from a request
 * parameter (BR-225).
 */
export const findForUser = async ({ id, userId, corporateAccountIds = [] }) =>
  prisma.order.findFirst({
    where: {
      id,
      OR: [
        { userId },
        ...(corporateAccountIds.length > 0
          ? [{ corporateAccountId: { in: corporateAccountIds } }]
          : []),
      ],
    },
    select: ORDER_DETAIL_FIELDS,
  });

export const findByQuoteId = async (quoteId) =>
  prisma.order.findUnique({ where: { quoteId }, select: ORDER_FIELDS });

/** Cursor-paginated list for one customer (ADR-014). */
export const listForUser = async ({ userId, corporateAccountIds = [], status, limit, cursor }) =>
  prisma.order.findMany({
    where: {
      OR: [
        { userId },
        ...(corporateAccountIds.length > 0
          ? [{ corporateAccountId: { in: corporateAccountIds } }]
          : []),
      ],
      ...(status ? { status: { in: status } } : {}),
    },
    select: ORDER_FIELDS,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

/** The administrative list. Unscoped by design; gated by `order.read.all`. */
export const listAll = async ({
  status,
  paymentMode,
  userId,
  corporateAccountId,
  city,
  search,
  createdAfter,
  createdBefore,
  limit,
  cursor,
}) =>
  prisma.order.findMany({
    where: {
      ...(status ? { status: { in: status } } : {}),
      ...(paymentMode ? { paymentMode } : {}),
      ...(userId ? { userId } : {}),
      ...(corporateAccountId ? { corporateAccountId } : {}),
      ...(city ? { city } : {}),
      /**
       * Order NUMBER only, never a free-text scan across snapshots.
       *
       * The human-readable number is what a customer reads over the phone
       * (BR-810), so it is the one thing support searches by. Widening this to
       * customer names would mean scanning the JSON snapshot columns, which are
       * unindexed - the exact "unindexed filter takes the database down" case
       * docs/10 §9.2 forbids.
       */
      ...(search ? { orderNumber: { contains: search.toUpperCase() } } : {}),
      ...(createdAfter || createdBefore
        ? {
            createdAt: {
              ...(createdAfter ? { gte: createdAfter } : {}),
              ...(createdBefore ? { lte: createdBefore } : {}),
            },
          }
        : {}),
    },
    select: ORDER_FIELDS,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

/**
 * Soft duplicate detection (BR-804).
 *
 * NOT the idempotency mechanism - that is a hard guarantee on a client-supplied
 * key. This catches the different failure: a customer who genuinely submitted
 * twice, minutes apart, with two different keys. The answer is a WARNING the
 * client may override, not a refusal.
 */
export const findRecentSimilar = async ({ userId, addressId, quantity, since }) =>
  prisma.order.findFirst({
    where: {
      userId,
      addressId,
      quantity,
      createdAt: { gte: since },
      status: { notIn: ['CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_ADMIN', 'EXPIRED'] },
    },
    select: { id: true, orderNumber: true, createdAt: true, status: true },
    orderBy: { createdAt: 'desc' },
  });

/**
 * THE STATUS WRITE. The only one.
 *
 * A CONDITIONAL CLAIM, not a lock (docs/08 §9.5: "Conditional claim | State
 * transitions with exactly one winner: offer acceptance, order state changes").
 * The `where` carries the status the caller believed the order was in; if
 * another transaction moved it first, zero rows match and the caller loses
 * cleanly instead of overwriting a decision it never saw.
 *
 * That is cheaper than `SELECT ... FOR UPDATE` and correct for this shape:
 * there is exactly one winner and the loser needs to know it lost, which is
 * precisely what a row count communicates.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @returns {Promise<number>} rows affected: 1 won, 0 lost.
 */
export const applyTransition = async (tx, { orderId, expectedStatus, toStatus, patch = {} }) => {
  const { count } = await tx.order.updateMany({
    where: { id: orderId, status: expectedStatus },
    data: { status: toStatus, statusChangedAt: new Date(), ...patch },
  });

  return count;
};

/** Append a timeline entry. Only ever called from the transition function. */
export const appendStatusEvent = async (tx, event) =>
  tx.orderStatusEvent.create({
    data: event,
    select: {
      id: true,
      orderId: true,
      fromStatus: true,
      toStatus: true,
      actorKind: true,
      actorUserId: true,
      reason: true,
      metadata: true,
      occurredAt: true,
    },
  });

/** The timeline, oldest first - the order a human reads it in. */
export const listStatusEvents = async ({ orderId, limit = 200 }) =>
  prisma.orderStatusEvent.findMany({
    where: { orderId },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      actorKind: true,
      actorUserId: true,
      reason: true,
      metadata: true,
      occurredAt: true,
    },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });

/** Non-terminal orders whose payment window has elapsed (BR-1006). */
export const findLapsedUnpaid = async ({ limit = 100, now = new Date() } = {}) =>
  prisma.order.findMany({
    where: {
      status: { in: ['DRAFT', 'PENDING_PAYMENT', 'PAYMENT_FAILED'] },
      expiresAt: { lt: now },
    },
    select: ORDER_FIELDS,
    orderBy: { expiresAt: 'asc' },
    take: limit,
  });

/**
 * Orders that have sat in one state too long (BR-811).
 *
 * The dwell-time watchdog's read. Thresholds are per state and are not yet
 * agreed - they follow from the publicly committed delivery SLA, which is
 * OQ-19 and still open - so the caller supplies them.
 */
export const findStalled = async ({ status, olderThan, limit = 100 }) =>
  prisma.order.findMany({
    where: { status, statusChangedAt: { lt: olderThan } },
    select: { ...ORDER_FIELDS },
    orderBy: { statusChangedAt: 'asc' },
    take: limit,
  });
