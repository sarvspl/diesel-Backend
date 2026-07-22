/**
 * JavaScript mirrors of the ordering Prisma enums, plus the vocabulary the
 * state machine is built from.
 *
 * Same reasoning as the identity, corporate, fleet and pricing mirrors: without
 * a compiler, a bare string literal that drifts from the schema fails at
 * runtime on whichever branch happens to use it. The enum-parity test asserts
 * these match.
 */

/**
 * THE FULFILMENT AXIS (docs/07 §2).
 *
 * One of THREE independent status fields on an order (ADR-007). This one
 * answers "where is the fuel in its journey?" - it says nothing about whether
 * money has moved, which is `PaymentStatus`, or whether the ordered-versus-
 * delivered difference has been resolved, which is `SettlementStatus`.
 *
 * Merging them forces invented states like `DELIVERED_PENDING_REFUND`, and then
 * another for every other combination. The concrete case that breaks a single
 * field: fuel delivered, invoice issued, card refund still processing.
 */
export const ORDER_STATUS = Object.freeze({
  /// Quote accepted, order not yet submitted.
  DRAFT: 'DRAFT',
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  /// Order accepted, fuel reserved.
  CONFIRMED: 'CONFIRMED',
  /// Looking for a vehicle.
  ALLOCATING: 'ALLOCATING',
  /// No vehicle could be found. Shown to the customer as "arranging a
  /// vehicle" - the same label as ALLOCATING, because they need to know the
  /// platform is still working, not that a round of offers was exhausted.
  ALLOCATION_FAILED: 'ALLOCATION_FAILED',
  ASSIGNED: 'ASSIGNED',
  EN_ROUTE: 'EN_ROUTE',
  ARRIVED: 'ARRIVED',
  DISPENSING: 'DISPENSING',
  /// Full quantity delivered. NOT terminal - fuel has moved but money has not
  /// settled (docs/07 §2).
  DELIVERED: 'DELIVERED',
  /// Less than ordered delivered. A Phase 1 state, not a future feature: a
  /// 200-litre order meeting a tank with room for 140 is expected on 10-30% of
  /// orders from day one (ADR-009, OQ-13).
  PARTIALLY_DELIVERED: 'PARTIALLY_DELIVERED',
  /// Nothing dispensed.
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
  CANCELLED_BY_ADMIN: 'CANCELLED_BY_ADMIN',
  /// Lapsed before it could be paid for or progressed (BR-1006, docs/07 §8 F2).
  ///
  /// NOT in docs/07 §2's list - see ADR-027. The documented behaviour is
  /// "auto-cancel after the window", but recording a system timeout as
  /// CANCELLED_BY_ADMIN attributes it to a human who did nothing, and corrupts
  /// the cancellation figures operations report on.
  EXPIRED: 'EXPIRED',
  /// Reconciled, invoiced, settled. THIS is what terminal means.
  CLOSED: 'CLOSED',
});

/**
 * THE PAYMENT AXIS (docs/07 §7).
 *
 * Present and written to on creation only. Payments is a later module; nothing
 * in this phase moves an order past PENDING. The field exists now because
 * retrofitting a second status axis onto a live orders table means migrating
 * every row and every query that filters on status.
 */
export const PAYMENT_STATUS = Object.freeze({
  /// Cash on delivery, until the driver collects.
  NOT_REQUIRED: 'NOT_REQUIRED',
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  CAPTURED: 'CAPTURED',
  SETTLED: 'SETTLED',
  FAILED: 'FAILED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  REFUNDED: 'REFUNDED',
});

/**
 * THE SETTLEMENT AXIS (docs/07 §6).
 *
 * Whether the ordered-versus-delivered difference has been resolved. Deliberately
 * small: reconciliation is a later module and inventing its full vocabulary now
 * would be speculative. These three are the states the ordering module itself
 * can honestly set.
 */
export const SETTLEMENT_STATUS = Object.freeze({
  /// Nothing delivered yet, or nothing to settle.
  NOT_REQUIRED: 'NOT_REQUIRED',
  /// Delivered quantity differs from ordered; a difference is owed either way.
  PENDING: 'PENDING',
  SETTLED: 'SETTLED',
});

/**
 * Payment mode, fixed at order creation and never changed afterwards (BR-807).
 *
 * Chosen per ORDER, not per customer (BR-248): a corporate buyer may mix credit,
 * prepaid and wallet freely.
 */
export const PAYMENT_MODE = Object.freeze({
  PREPAID_ONLINE: 'PREPAID_ONLINE',
  WALLET: 'WALLET',
  CASH_ON_DELIVERY: 'CASH_ON_DELIVERY',
  CORPORATE_CREDIT: 'CORPORATE_CREDIT',
});

/**
 * Payment modes this phase can honestly accept.
 *
 * WALLET and CORPORATE_CREDIT both require placing a HOLD against a balance,
 * in modules that do not exist yet. Accepting them and skipping the hold would
 * let a customer order past their limit - the exact failure BR-235 exists to
 * prevent - so they are refused at the boundary rather than silently
 * half-implemented.
 */
export const IMPLEMENTED_PAYMENT_MODES = Object.freeze([
  PAYMENT_MODE.CASH_ON_DELIVERY,
  PAYMENT_MODE.PREPAID_ONLINE,
]);

/**
 * Who caused a transition.
 *
 * SYSTEM is not a login (docs/03 §5). Scheduled jobs act as SYSTEM in the
 * timeline, and they MUST appear there: "when a reservation is released
 * automatically, the timeline must show that, not an unexplained gap".
 */
export const ACTOR_KIND = Object.freeze({
  CUSTOMER: 'CUSTOMER',
  DRIVER: 'DRIVER',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
});

/** Reservation lifecycle (docs/05 §7 FuelReservation). */
export const RESERVATION_STATUS = Object.freeze({
  HELD: 'HELD',
  CONSUMED: 'CONSUMED',
  RELEASED: 'RELEASED',
  EXPIRED: 'EXPIRED',
});

/** Why a reservation stopped being held. Recorded so the log answers "why". */
export const RESERVATION_RELEASE_REASON = Object.freeze({
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_EXPIRED: 'ORDER_EXPIRED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  REALLOCATION: 'REALLOCATION',
  SWEPT_EXPIRED: 'SWEPT_EXPIRED',
  ADMIN_RELEASE: 'ADMIN_RELEASE',
});

/** Idempotency record lifecycle (docs/10 §8.2). */
export const IDEMPOTENCY_STATE = Object.freeze({
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
});

/** Outbox row lifecycle (docs/05 §12 OutboxEvent). */
export const OUTBOX_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  FAILED: 'FAILED',
});

/**
 * Statuses a customer may cancel from without operator involvement
 * (docs/07 §5, BR-1201).
 *
 * Everything up to and including ASSIGNED: the driver has been given the job
 * but has not started travelling, so nothing is wasted by cancelling.
 */
export const CUSTOMER_CANCELLABLE_STATUSES = Object.freeze([
  ORDER_STATUS.DRAFT,
  ORDER_STATUS.PENDING_PAYMENT,
  ORDER_STATUS.PAYMENT_FAILED,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.ALLOCATING,
  ORDER_STATUS.ALLOCATION_FAILED,
  ORDER_STATUS.ASSIGNED,
]);

/**
 * Statuses where in-app cancellation is BLOCKED and the customer may only
 * request one (BR-1202, docs/07 §5).
 *
 * A tanker is moving, or fuel is flowing. Cancelling is now an operational
 * decision with a cost attached, not a self-service action.
 */
export const CANCELLATION_REQUEST_STATUSES = Object.freeze([
  ORDER_STATUS.EN_ROUTE,
  ORDER_STATUS.ARRIVED,
  ORDER_STATUS.DISPENSING,
]);

/**
 * Terminal statuses. Nothing transitions out of these.
 *
 * DELIVERED is deliberately ABSENT: fuel has moved but money has not settled,
 * and CLOSED is what terminal means (docs/07 §2).
 */
export const TERMINAL_STATUSES = Object.freeze([
  ORDER_STATUS.CANCELLED_BY_CUSTOMER,
  ORDER_STATUS.CANCELLED_BY_ADMIN,
  ORDER_STATUS.EXPIRED,
  ORDER_STATUS.CLOSED,
]);

/**
 * Statuses from which NOTHING can be cancelled, by anyone.
 *
 * RESOLVES A CONTRADICTION INSIDE docs/07 §5. That section says "The
 * administrator can cancel from any non-terminal state", and four lines earlier
 * lists DELIVERED and PARTIALLY_DELIVERED under "Not cancellable at all -
 * this is a dispute, not a cancellation. Resolution is a CREDIT NOTE against
 * the invoice."
 *
 * The specific rule wins, and BR-1207 states it as a numbered rule rather than
 * a passing generalisation. It is also the only reading that survives contact
 * with reality: fuel physically left the tanker, and an order that says
 * otherwise makes the books disagree with the world.
 *
 * DELIVERY_FAILED is included for the mirror-image reason: BR-921 already
 * defines its resolution - bill nothing, release the holds, refund in full,
 * then CLOSE. Cancelling it would route the same outcome around the
 * reconciliation path rather than through it.
 *
 * The coherent rule underneath all three: an order may be cancelled until an
 * OUTCOME has been recorded. After that it is reconciled, not cancelled.
 */
export const OUTCOME_RECORDED_STATUSES = Object.freeze([
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.PARTIALLY_DELIVERED,
  ORDER_STATUS.DELIVERY_FAILED,
]);

/**
 * Statuses that hold a live claim on a tanker's fuel.
 *
 * Used by the reservation sweeper and by the dispatch board's partial index.
 */
export const RESERVATION_HOLDING_STATUSES = Object.freeze([
  ORDER_STATUS.PENDING_PAYMENT,
  ORDER_STATUS.PAYMENT_FAILED,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.ALLOCATING,
  ORDER_STATUS.ALLOCATION_FAILED,
  ORDER_STATUS.ASSIGNED,
  ORDER_STATUS.EN_ROUTE,
  ORDER_STATUS.ARRIVED,
  ORDER_STATUS.DISPENSING,
]);

/**
 * Order number prefix. `DFY-2607-000123`.
 *
 * A human-readable reference distinct from the UUID (BR-810, ADR-005): nobody
 * reads a UUID over the phone. Deliberately NOT a bare counter - `order/1847`
 * tells a competitor the exact order count.
 */
export const ORDER_NUMBER_PREFIX = 'DFY';

/**
 * How long an order may sit unpaid before it expires and gives its fuel back
 * (BR-1006). A system setting in the long run (docs/11 §8.1); an env value for
 * now, because the settings table does not exist yet.
 */
export const DEFAULT_ORDER_EXPIRY_MINUTES = 30;
