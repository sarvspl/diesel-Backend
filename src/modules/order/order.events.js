import { toMoneyString, toQuantityString } from '../../shared/utils/money.js';

/**
 * The events this module publishes (docs/09 §9).
 *
 * `domain.action`, past tense (docs/11 §3). These are emitted from day one even
 * though nothing consumes them yet - docs/09 §16 is explicit that "event
 * producers must write outbox events from P1c onward, even before this module
 * exists. Retrofitting event emission is far harder than retrofitting a
 * consumer."
 */
export const ORDER_EVENTS = Object.freeze({
  CREATED: 'order.created',
  CONFIRMED: 'order.confirmed',
  STATUS_CHANGED: 'order.status.changed',
  CANCELLED: 'order.cancelled',
  EXPIRED: 'order.expired',
  /// Asks Dispatch to start looking for a vehicle. Ordering never allocates.
  ALLOCATION_REQUESTED: 'allocation.requested',
});

/** Reservation events. Fleet's vocabulary (docs/09 §6), emitted by Dispatch. */
export const FUEL_EVENTS = Object.freeze({
  RESERVED: 'fuel.reserved',
  RELEASED: 'fuel.released',
});

export const AGGREGATE = 'order';

/**
 * Build a SELF-CONTAINED payload.
 *
 * A consumer must never have to read this module's tables to do its job
 * (docs/06 §19, anti-pattern 7: "Notifications reads order tables to build a
 * message ... The event payload carries what the message needs"). So the
 * customer's name, the amount and the address summary travel WITH the event
 * rather than as an id the consumer has to resolve.
 *
 * Money and quantities are strings here too (ADR-015). An outbox payload is
 * JSON, and a JSON number is a double the moment anything parses it - including
 * the worker that will eventually render an invoice from this.
 */
export const orderEventPayload = (order, extra = {}) => ({
  orderId: order.id,
  orderNumber: order.orderNumber,
  userId: order.userId,
  corporateAccountId: order.corporateAccountId ?? null,
  status: order.status,
  paymentStatus: order.paymentStatus,
  paymentMode: order.paymentMode,
  quantity: toQuantityString(order.quantity),
  totalAmount: toMoneyString(order.totalAmount),
  currency: 'INR',
  city: order.city,
  /// Enough for a notification to say where, without the full snapshot.
  addressLine: order.addressSnapshot?.line1 ?? null,
  customerName: order.customerSnapshot?.fullName ?? null,
  placedAt: order.placedAt,
  ...extra,
});
