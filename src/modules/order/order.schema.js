import { z } from 'zod';

import { ORDER_STATUS, PAYMENT_MODE } from '../../shared/constants/order.js';

/** Request validation for the ordering module. */

const uuid = (label) => z.string().uuid(`${label} must be a UUID`);

/**
 * A comma-separated status filter: `?status=ASSIGNED,EN_ROUTE` (docs/10 §9.2).
 *
 * Every value is checked against the enum rather than passed through, because
 * an unrecognised status would reach Prisma and surface as a raw database error
 * instead of a validation message.
 */
const statusFilter = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  )
  .refine(
    (values) => values.every((value) => Object.values(ORDER_STATUS).includes(value)),
    `status must be a comma-separated list of: ${Object.values(ORDER_STATUS).join(', ')}`
  );

const isoTimestamp = z
  .string()
  .datetime({ message: 'Must be an ISO 8601 timestamp' })
  .transform((value) => new Date(value));

/**
 * A cancellation reason is REQUIRED, never defaulted.
 *
 * docs/04 §5 puts "select reason" in the customer flow, and BR-1206 requires
 * one from an administrator. An unexplained cancellation is a support call
 * nobody can answer, and a default like "cancelled by user" is the same as
 * having none.
 */
const reason = z.string().trim().min(3, 'Give a reason of at least 3 characters').max(1000);

// --- Customer ---------------------------------------------------------------

export const createOrderSchema = {
  body: z.object({
    /**
     * The only pricing input. There is no quantity, no price and no address
     * here: all three come from the quote, which the server computed (BR-603,
     * BR-801). A client that could vary them at order time would be able to
     * order 200 litres at the price of 20.
     */
    quoteId: uuid('Quote id'),

    /// Fixed at creation and never changed afterwards (BR-807).
    paymentMode: z.enum(Object.values(PAYMENT_MODE)),

    deliveryInstructions: z.string().trim().max(500).optional(),

    /**
     * The customer's answer to a soft duplicate warning (BR-804).
     *
     * Default false so the warning fires by default; a client that has shown
     * the "you ordered this a few minutes ago" prompt resubmits with true.
     */
    acknowledgeDuplicate: z.boolean().default(false),
  }),
};

export const listOrdersSchema = {
  query: z.object({
    status: statusFilter.optional(),
    /// Default 20, maximum 100 (docs/10 §9.1).
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().uuid().optional(),
  }),
};

export const orderIdSchema = {
  params: z.object({ id: uuid('Order id') }),
};

export const cancelOrderSchema = {
  params: z.object({ id: uuid('Order id') }),
  body: z.object({ reason }),
};

// --- Admin ------------------------------------------------------------------

export const listAllOrdersSchema = {
  query: z.object({
    status: statusFilter.optional(),
    paymentMode: z.enum(Object.values(PAYMENT_MODE)).optional(),
    userId: z.string().uuid().optional(),
    corporateAccountId: z.string().uuid().optional(),
    city: z.string().trim().max(120).optional(),
    /// Order number, whole or partial: `DFY-2607-000123` or `000123`.
    search: z.string().trim().min(1).max(40).optional(),
    /// Range filters use After/Before and are inclusive (docs/10 §9.2).
    createdAfter: isoTimestamp.optional(),
    createdBefore: isoTimestamp.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().uuid().optional(),
  }),
};

export const transitionOrderSchema = {
  params: z.object({ id: uuid('Order id') }),
  body: z.object({
    /**
     * The target state. Whether it is REACHABLE from where the order is now is
     * not a schema question - it depends on the row - so it is checked by the
     * transition table in the service (docs/11 §4.3: "Business validation
     * belongs in services, not schemas").
     *
     * The two cancellation states are excluded here: they have their own
     * endpoint, which requires `order.cancel` rather than `order.adjust` and
     * records the canceller. Routing a cancellation through the generic
     * transition endpoint would bypass both.
     */
    toStatus: z.enum(
      Object.values(ORDER_STATUS).filter(
        (status) =>
          status !== ORDER_STATUS.CANCELLED_BY_CUSTOMER &&
          status !== ORDER_STATUS.CANCELLED_BY_ADMIN
      )
    ),
    reason,
    metadata: z.record(z.string(), z.unknown()).optional(),
    /**
     * Optional optimistic guard. An operator acting on a stale dispatch board
     * can send the status they believed the order was in, and be refused rather
     * than acting on an order that has moved.
     */
    expectedStatus: z.enum(Object.values(ORDER_STATUS)).optional(),
  }),
};

export const reserveSchema = {
  params: z.object({ id: uuid('Order id') }),
  body: z.object({
    /// Omit to let the service pick any vehicle with enough unreserved fuel.
    vehicleId: z.string().uuid().optional(),
  }),
};

export const releaseSchema = {
  params: z.object({ id: uuid('Order id') }),
  body: z.object({
    reason: z.string().trim().min(3).max(1000).optional(),
  }),
};
