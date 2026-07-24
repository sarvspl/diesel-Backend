import { env } from '../../../config/env.js';
import { prisma } from '../../../infrastructure/database/prisma.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { HTTP_STATUS } from '../../../shared/constants/http-status.js';
import {
  ACTOR_KIND,
  IMPLEMENTED_PAYMENT_MODES,
  ORDER_STATUS,
  PAYMENT_MODE,
  PAYMENT_STATUS,
  RESERVATION_RELEASE_REASON,
  SETTLEMENT_STATUS,
} from '../../../shared/constants/order.js';
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import { toMoneyString, toQuantityString } from '../../../shared/utils/money.js';
import { assertMayOrder } from '../../corporate/services/corporate-gate.js';
import * as reservationService from '../../dispatch/services/reservation.service.js';
import * as outboxService from '../../platform/services/outbox.service.js';
import { AGGREGATE, ORDER_EVENTS, orderEventPayload } from '../order.events.js';
import * as orderRepository from '../repositories/order.repository.js';

import { toPublicOrder } from './order-view.js';

const log = createLogger({ module: 'order.create' });

/**
 * Quote -> Order conversion (BR-801, ADR-010).
 *
 * NOTHING IS PRICED HERE. The quote already holds a server-computed,
 * line-level, frozen breakdown; this copies it. That is the entire point of
 * two-step ordering: a client can never submit a price the server did not
 * compute (BR-603), and the price lock is explicit and auditable rather than
 * implicit in whatever the pricing tables happened to say at insert time.
 *
 * The order then references the exact PRICE VERSION (`priceId`) the quote used,
 * so a price published one second later cannot alter it (BR-606).
 */

/**
 * Freeze the customer, address, product and pricing as they are right now.
 *
 * WHY DUPLICATE DATA WE COULD JOIN TO: because the join would give the WRONG
 * ANSWER later. A customer who renames their site, corrects a typo in their
 * address or changes their phone number must not retroactively alter a delivery
 * note that has already been acted on (BR-805). docs/08 §1.5: "if a value
 * appears on a legal or financial document, snapshot it. The cost is
 * duplication."
 *
 * These objects are written once and never updated - enforced by a database
 * trigger, not by convention. See the migration.
 */
const buildSnapshots = ({ customer, user, address, product, quote }) => ({
  customerSnapshot: {
    userId: user.id,
    fullName: customer?.fullName ?? null,
    phone: user.phone ?? null,
    email: user.email ?? null,
    /// What the invoice will be addressed to, at this moment.
    capturedAt: new Date().toISOString(),
  },

  addressSnapshot: {
    addressId: address.id,
    nickname: address.nickname,
    line1: address.line1,
    line2: address.line2,
    landmark: address.landmark,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
    /// Coordinates as STRINGS. They drive dispatch distance and geofence
    /// deviation, and a double reintroduces drift in exactly the comparison
    /// that decides whether a delivery happened where it should.
    latitude: address.latitude?.toString() ?? null,
    longitude: address.longitude?.toString() ?? null,
    contactName: address.contactName,
    contactPhone: address.contactPhone,
    deliveryInstructions: address.deliveryInstructions,
    capturedAt: new Date().toISOString(),
  },

  productSnapshot: {
    productId: product.id,
    code: product.code,
    name: product.name,
    unit: product.unit,
    /// Required on every goods line of a tax invoice (BR-706).
    hsnCode: product.hsnCode,
  },

  /**
   * The line-level computation, copied verbatim from the quote.
   *
   * The invoice is built from THIS, never from live pricing configuration
   * (BR-606). It already contains the price version, the tax components and
   * their regimes, so a later change to a tax rule cannot rewrite what this
   * order was charged.
   */
  pricingSnapshot: {
    quoteId: quote.id,
    priceId: quote.priceId,
    ...quote.breakdown,
    frozenAt: new Date().toISOString(),
  },
});

/**
 * Place an order.
 *
 * ONE TRANSACTION, because partial success here means fuel reserved for an
 * order that does not exist, or an order with no timeline (docs/08 §8.1:
 * "Placing an order - validating the quote, reserving fuel, placing a credit
 * hold, creating the order, writing the first status event, writing outbox
 * events - is one transaction").
 *
 * The reservation is the deliberate exception and is taken BEFORE the
 * transaction opens - see the note at the reservation step.
 *
 * @returns {Promise<{ status: number, body: object, resourceId: string }>}
 *   Shaped for the idempotency wrapper, which stores and replays it verbatim.
 */
export const createOrder = async ({
  userId,
  quoteId,
  paymentMode,
  deliveryInstructions = null,
  acknowledgeDuplicate = false,
  requestId = null,
}) => {
  // --- 0. May this caller buy at all? ---------------------------------------
  // Verification exists to stop an unverified company ordering, and until now
  // the LOGIN gate was the only thing enforcing it — safe only while every
  // unapproved member was locked out. Rejected applicants are now let in so
  // they can correct their details (BR-206), so the rule is enforced here,
  // where it actually belongs.
  //
  // Individuals are unaffected: the check has no opinion about a caller with no
  // corporate membership.
  await assertMayOrder(userId);

  // --- 1. Payment mode ------------------------------------------------------
  // Refused at the boundary rather than half-implemented. WALLET and
  // CORPORATE_CREDIT both require a HOLD against a balance, in modules that do
  // not exist; accepting them and skipping the hold would let a customer order
  // past their limit, which is the exact failure BR-235 exists to prevent.
  if (!IMPLEMENTED_PAYMENT_MODES.includes(paymentMode)) {
    throw new BadRequestError(
      `${paymentMode} is not available yet. Use cash on delivery or pay online.`,
      {
        code: ERROR_CODES.PAYMENT_MODE_UNSUPPORTED,
        details: { supported: IMPLEMENTED_PAYMENT_MODES },
      }
    );
  }

  // --- 2. The quote ---------------------------------------------------------
  const quote = await prisma.quote.findFirst({
    where: { id: quoteId, userId },
    select: {
      id: true,
      userId: true,
      addressId: true,
      productId: true,
      priceId: true,
      quantity: true,
      fuelAmount: true,
      deliveryAmount: true,
      taxAmount: true,
      totalAmount: true,
      breakdown: true,
      city: true,
      state: true,
      status: true,
      expiresAt: true,
    },
  });

  // Scoped to the caller, so someone else's quote is indistinguishable from a
  // quote that does not exist (docs/10 §6: 404, not 403 - a 403 confirms it
  // exists).
  if (!quote) {
    throw new NotFoundError('Quote not found', { code: ERROR_CODES.QUOTE_NOT_FOUND });
  }

  /**
   * BR-802: a quote is single use.
   *
   * Checked here for a good error message; the UNIQUE constraint on
   * `orders.quote_id` is what actually guarantees it. Two simultaneous
   * submissions of one quote both pass this check - there is no lock - and the
   * second one fails on the constraint below, which is the correct outcome
   * (docs/08 §9.4).
   */
  if (quote.status === 'CONSUMED') {
    throw new ConflictError('That quote has already been used to place an order', {
      code: ERROR_CODES.QUOTE_ALREADY_USED,
    });
  }

  /**
   * BR-605: an expired quote must be re-quoted with an explicit
   * "price changed from X to Y, confirm" step. NEVER silently repriced.
   *
   * 410 Gone rather than 409 Conflict (docs/10 §6): the quote is not in
   * conflict with anything, it has ceased to be a usable thing. The client's
   * response is to request a new quote and show the comparison, which is a
   * different screen from any 409.
   */
  if (quote.status === 'EXPIRED' || quote.expiresAt <= new Date()) {
    throw new AppError('That quote has expired. Request a new one to see the current price.', {
      statusCode: HTTP_STATUS.GONE,
      code: ERROR_CODES.QUOTE_EXPIRED,
      details: { quoteId: quote.id, expiredAt: quote.expiresAt },
    });
  }

  // --- 3. The parties -------------------------------------------------------
  const [user, customer, address, product] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, email: true },
    }),
    prisma.customerProfile.findUnique({
      where: { userId },
      select: { fullName: true },
    }),
    prisma.address.findFirst({
      where: { id: quote.addressId, userId },
      select: {
        id: true,
        nickname: true,
        line1: true,
        line2: true,
        landmark: true,
        city: true,
        state: true,
        pincode: true,
        latitude: true,
        longitude: true,
        contactName: true,
        contactPhone: true,
        deliveryInstructions: true,
        archivedAt: true,
      },
    }),
    prisma.fuelProduct.findUnique({
      where: { id: quote.productId },
      select: { id: true, code: true, name: true, unit: true, hsnCode: true, status: true },
    }),
  ]);

  if (!address) {
    throw new NotFoundError('Delivery address not found');
  }

  if (!product || product.status !== 'ACTIVE') {
    throw new ConflictError('That product is no longer available', {
      code: ERROR_CODES.PRODUCT_INACTIVE,
    });
  }

  // --- 4. Soft duplicate warning (BR-804) -----------------------------------
  // Distinct from idempotency: this catches a genuine second submission minutes
  // later with a different key. A WARNING the client may override, never a
  // refusal - a customer topping up twice in an hour is a real thing.
  if (!acknowledgeDuplicate && env.DUPLICATE_ORDER_WINDOW_MINUTES > 0) {
    const since = new Date(Date.now() - env.DUPLICATE_ORDER_WINDOW_MINUTES * 60_000);

    const similar = await orderRepository.findRecentSimilar({
      userId,
      addressId: quote.addressId,
      quantity: quote.quantity,
      since,
    });

    if (similar) {
      throw new ConflictError(
        `You placed an identical order (${similar.orderNumber}) a few minutes ago. Confirm to place another.`,
        {
          code: ERROR_CODES.DUPLICATE_ORDER,
          details: {
            existingOrderId: similar.id,
            existingOrderNumber: similar.orderNumber,
            placedAt: similar.createdAt,
            /// How the client proceeds: resubmit with this set.
            resolution: 'Resubmit with acknowledgeDuplicate: true',
          },
        }
      );
    }
  }

  // --- 5. Corporate attribution (BR-223) ------------------------------------
  // Derived from the TOKEN's identity, never from a request parameter (BR-225).
  // Both the company and the member are recorded, and both survive that member
  // later being removed (BR-224).
  const membership = await prisma.corporateMember.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true, corporateAccountId: true },
  });

  const snapshots = buildSnapshots({ customer, user, address, product, quote });

  /**
   * COD is confirmed immediately; prepaid waits for a verified webhook
   * (docs/04 §2). The client's success callback is a hint, never the source of
   * truth (BR-1001) - which is why a prepaid order lands in PENDING_PAYMENT and
   * nothing in this module can move it out.
   */
  const isCod = paymentMode === PAYMENT_MODE.CASH_ON_DELIVERY;

  const initialStatus = isCod ? ORDER_STATUS.CONFIRMED : ORDER_STATUS.PENDING_PAYMENT;
  const initialPaymentStatus = isCod ? PAYMENT_STATUS.NOT_REQUIRED : PAYMENT_STATUS.PENDING;

  // --- 6. Create ------------------------------------------------------------
  const order = await prisma.$transaction(async (tx) => {
    const orderNumber = await orderRepository.allocateOrderNumber(tx);

    const created = await orderRepository.create(tx, {
      orderNumber,
      userId,
      corporateAccountId: membership?.corporateAccountId ?? null,
      corporateMemberId: membership?.id ?? null,
      quoteId: quote.id,
      addressId: address.id,
      productId: product.id,
      priceId: quote.priceId,
      quantity: quote.quantity,

      // Copied, never recomputed (BR-606).
      fuelAmount: quote.fuelAmount,
      deliveryAmount: quote.deliveryAmount,
      taxAmount: quote.taxAmount,
      totalAmount: quote.totalAmount,

      ...snapshots,

      status: initialStatus,
      paymentStatus: initialPaymentStatus,
      settlementStatus: SETTLEMENT_STATUS.NOT_REQUIRED,
      paymentMode,

      // The clock on an unpaid order (BR-1006). A COD order is already
      // confirmed, so it has none.
      expiresAt: isCod ? null : new Date(Date.now() + env.ORDER_PAYMENT_WINDOW_MINUTES * 60_000),

      city: quote.city,
      state: quote.state,
      deliveryInstructions: deliveryInstructions ?? address.deliveryInstructions ?? null,
    });

    /**
     * Spend the quote, conditionally.
     *
     * `updateMany ... where status: 'ACTIVE'` is a conditional claim: if
     * another transaction consumed it first, zero rows change and we abort.
     * Belt and braces alongside the unique constraint on `quote_id`, because
     * this one produces a clean domain error rather than a constraint violation.
     */
    const { count } = await tx.quote.updateMany({
      where: { id: quote.id, status: 'ACTIVE' },
      data: { status: 'CONSUMED' },
    });

    if (count === 0) {
      throw new ConflictError('That quote has already been used to place an order', {
        code: ERROR_CODES.QUOTE_ALREADY_USED,
      });
    }

    /**
     * The opening timeline entry.
     *
     * `fromStatus` is NULL - an order coming into existence has no previous
     * state, and a sentinel would be a lie. This is the one status event NOT
     * written by the transition function, because there is no transition: the
     * row and its first event are created together.
     */
    await orderRepository.appendStatusEvent(tx, {
      orderId: created.id,
      fromStatus: null,
      toStatus: initialStatus,
      actorKind: ACTOR_KIND.CUSTOMER,
      actorUserId: userId,
      reason: isCod
        ? 'Order placed, cash on delivery'
        : 'Order placed, awaiting payment confirmation',
      metadata: { quoteId: quote.id, paymentMode },
      requestId,
    });

    const events = [
      {
        aggregate: AGGREGATE,
        aggregateId: created.id,
        eventType: ORDER_EVENTS.CREATED,
        payload: orderEventPayload(created),
      },
    ];

    if (isCod) {
      events.push({
        aggregate: AGGREGATE,
        aggregateId: created.id,
        eventType: ORDER_EVENTS.CONFIRMED,
        payload: orderEventPayload(created),
      });
      // Ordering asks for a vehicle; it never allocates one (docs/06 §9).
      events.push({
        aggregate: AGGREGATE,
        aggregateId: created.id,
        eventType: ORDER_EVENTS.ALLOCATION_REQUESTED,
        payload: orderEventPayload(created),
      });
    }

    await outboxService.publishAll(tx, events);

    return created;
  });

  /**
   * --- 7. Reserve the fuel (BR-406) ----------------------------------------
   *
   * OUTSIDE the order transaction, and this is the most debatable decision in
   * the module, so it is worth stating plainly.
   *
   * docs/08 §8.1 puts reservation inside the placement transaction. Doing that
   * literally means holding a `FOR UPDATE` lock on one tanker's inventory row
   * across the order insert, the quote update, the status event and the outbox
   * writes - serialising every order for that vehicle behind the slowest one.
   *
   * The compromise: the ORDER is atomic, and the reservation follows
   * immediately. If reserving fails, the order is cancelled in the same call,
   * so the customer sees one clean failure rather than an order stuck without
   * fuel. The window in between is bounded by this function.
   *
   * What makes this acceptable rather than merely convenient: a reservation is
   * a promise, not money, and an order briefly holding none is a state the
   * allocator and the expiry sweeper both already handle. The reverse - an
   * order that does not exist holding fuel - is not, which is why the
   * reservation is second rather than first.
   */
  try {
    const reservation = await reservationService.reserve({
      orderId: order.id,
      quantity: order.quantity,
      actorUserId: userId,
    });

    await prisma.$transaction(async (tx) => {
      await outboxService.publish(tx, {
        aggregate: AGGREGATE,
        aggregateId: order.id,
        eventType: 'fuel.reserved',
        payload: {
          orderId: order.id,
          reservationId: reservation.id,
          vehicleId: reservation.vehicleId,
          quantity: toQuantityString(reservation.quantity),
        },
      });
    });
  } catch (error) {
    log.warn(
      { err: error, orderId: order.id, quantity: String(order.quantity) },
      'could not reserve fuel for a newly placed order - cancelling it'
    );

    // Lazily imported: transition-order imports nothing from this file, but
    // importing it at module scope here would still create an avoidable
    // module-load cycle through the shared service graph.
    const { transitionOrder } = await import('./transition-order.service.js');

    await transitionOrder({
      orderId: order.id,
      toStatus: ORDER_STATUS.CANCELLED_BY_ADMIN,
      actorKind: ACTOR_KIND.SYSTEM,
      reason: 'No vehicle had enough unreserved fuel at the time of placement',
      metadata: { failure: error.code ?? 'RESERVATION_FAILED' },
      requestId,
    });

    throw new ConflictError(
      'We could not reserve fuel for that order. No tanker currently has enough available.',
      {
        code: ERROR_CODES.NO_VEHICLE_AVAILABLE,
        details: { orderNumber: order.orderNumber, requested: toQuantityString(order.quantity) },
      }
    );
  }

  log.info(
    {
      orderId: order.id,
      orderNumber: order.orderNumber,
      userId,
      paymentMode,
      totalAmount: toMoneyString(order.totalAmount),
    },
    'order placed'
  );

  const fresh = await orderRepository.findById(order.id);

  return {
    status: HTTP_STATUS.CREATED,
    body: {
      success: true,
      message: 'Order placed',
      data: { order: toPublicOrder(fresh) },
    },
    resourceId: order.id,
  };
};

export { RESERVATION_RELEASE_REASON };
