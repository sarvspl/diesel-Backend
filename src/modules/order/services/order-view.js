import { toMoneyString, toQuantityString } from '../../../shared/utils/money.js';

/**
 * Response projections.
 *
 * TWO SHAPES, and the difference between them is a security boundary rather
 * than a convenience:
 *
 *   toPublicOrder   what a customer may see about their own order
 *   toAdminOrder    everything, for operations and support
 *
 * A customer never sees which tanker holds their fuel, which vehicles were
 * considered, or the internal reservation. "Never expose internal reservation
 * details to customers" - those are operational facts about fleet capacity, and
 * a customer knowing their order sits on vehicle X learns something that is
 * none of their business.
 *
 * Money and quantities are STRINGS on the wire (ADR-015, control M7). A JSON
 * number is a double the moment any client parses it, which would undo the
 * exactness the whole money stack exists to preserve.
 */

/** Shared between both projections. */
const base = (order) => ({
  id: order.id,
  orderNumber: order.orderNumber,
  status: order.status,
  paymentStatus: order.paymentStatus,
  settlementStatus: order.settlementStatus,
  paymentMode: order.paymentMode,

  quantity: toQuantityString(order.quantity),
  deliveredQuantity:
    order.deliveredQuantity === null ? null : toQuantityString(order.deliveredQuantity),

  currency: 'INR',
  fuelAmount: toMoneyString(order.fuelAmount),
  deliveryAmount: toMoneyString(order.deliveryAmount),
  taxAmount: toMoneyString(order.taxAmount),
  totalAmount: toMoneyString(order.totalAmount),
  finalTotalAmount: order.finalTotalAmount === null ? null : toMoneyString(order.finalTotalAmount),

  placedAt: order.placedAt,
  statusChangedAt: order.statusChangedAt,
  expiresAt: order.expiresAt,
});

/**
 * The customer's view of their own order.
 *
 * Includes the frozen address and product, because those are what the customer
 * agreed to and they must see the same thing the driver will. Includes the
 * pricing breakdown, because a customer is entitled to know what they are being
 * charged and why.
 *
 * Excludes: the reservation, the vehicle, the corporate member id, the internal
 * price version, and every `*ByUserId` audit column.
 */
export const toPublicOrder = (order) => ({
  ...base(order),

  product: order.productSnapshot
    ? {
        code: order.productSnapshot.code,
        name: order.productSnapshot.name,
        unit: order.productSnapshot.unit,
      }
    : undefined,

  deliveryAddress: order.addressSnapshot
    ? {
        nickname: order.addressSnapshot.nickname,
        line1: order.addressSnapshot.line1,
        line2: order.addressSnapshot.line2,
        landmark: order.addressSnapshot.landmark,
        city: order.addressSnapshot.city,
        state: order.addressSnapshot.state,
        pincode: order.addressSnapshot.pincode,
        contactName: order.addressSnapshot.contactName,
        contactPhone: order.addressSnapshot.contactPhone,
      }
    : undefined,

  deliveryInstructions: order.deliveryInstructions,

  /**
   * The line-level breakdown only. NOT the price version id, the sanity band,
   * or anything else about how the platform prices - the same restraint the
   * quote projection applies.
   */
  breakdown: order.pricingSnapshot
    ? {
        lines: order.pricingSnapshot.lines,
        totals: order.pricingSnapshot.totals,
      }
    : undefined,

  cancellation: order.cancelledAt
    ? {
        cancelledAt: order.cancelledAt,
        cancelledBy: order.cancelledByKind,
        reason: order.cancellationReason,
      }
    : null,
});

/**
 * The operations view.
 *
 * Everything the customer sees, plus the internal references support needs to
 * answer "why did this happen" without a database console.
 */
export const toAdminOrder = (order) => ({
  ...base(order),

  userId: order.userId,
  corporateAccountId: order.corporateAccountId,
  corporateMemberId: order.corporateMemberId,

  quoteId: order.quoteId,
  addressId: order.addressId,
  productId: order.productId,
  /// The exact price version this order is billed at.
  priceId: order.priceId,

  city: order.city,
  state: order.state,
  deliveryInstructions: order.deliveryInstructions,

  customerSnapshot: order.customerSnapshot,
  addressSnapshot: order.addressSnapshot,
  productSnapshot: order.productSnapshot,
  pricingSnapshot: order.pricingSnapshot,

  cancellation: order.cancelledAt
    ? {
        cancelledAt: order.cancelledAt,
        cancelledBy: order.cancelledByKind,
        cancelledByUserId: order.cancelledByUserId,
        reason: order.cancellationReason,
      }
    : null,

  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

/** A list row. Deliberately lean - a list must not drag four JSON documents. */
export const toOrderSummary = (order) => ({
  ...base(order),
  city: order.city,
});

/**
 * One timeline entry (docs/04 §26).
 *
 * The customer's timeline shows what happened and when. It does NOT show
 * `metadata`, which carries reservation ids, vehicle ids and gateway event
 * references - internal facts that exist for support, not for the customer.
 */
export const toPublicTimelineEntry = (event) => ({
  status: event.toStatus,
  previousStatus: event.fromStatus,
  actor: event.actorKind,
  reason: event.reason,
  occurredAt: event.occurredAt,
});

/** The support view: adds who, and the structured context. */
export const toAdminTimelineEntry = (event) => ({
  ...toPublicTimelineEntry(event),
  actorUserId: event.actorUserId,
  metadata: event.metadata,
});
