import { prisma } from '../../../infrastructure/database/prisma.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { METER_READING_SOURCE, METER_READING_TYPE } from '../../../shared/constants/fleet.js';
import { ACTOR_KIND, ORDER_STATUS } from '../../../shared/constants/order.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import { transitionOrder } from '../../order/services/transition-order.service.js';
import * as driverOrderRepository from '../repositories/driver-order.repository.js';

import { resolveDriverProfile } from './driver-self.service.js';

const log = createLogger({ module: 'driver.delivery' });

/**
 * Delivery execution.
 *
 * THE THREE RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. THERE IS NO "QUANTITY DELIVERED" FIELD. Billed quantity is
 *    `closing − opening`, from two meter totaliser readings (BR-901). A driver
 *    cannot type a number that suits them, and no endpoint here accepts one.
 *
 * 2. CLOSING BELOW OPENING HAS TWO DISTINCT OUTCOMES (BR-903, BR-904).
 *    A genuine meter ROLLOVER is accepted and computed across the wrap. Anything
 *    else is REJECTED as a meter fault needing a human. Conflating them either
 *    bills a customer for a meter's maximum, or refuses a legitimate delivery.
 *
 * 3. THE DELIVERY MUST BE RECORDABLE OFFLINE (BR-914). Submission carries a
 *    client-generated identifier; replaying it returns the ORIGINAL result
 *    rather than creating a second delivery. A tanker in a basement has no
 *    signal, and the fuel still leaves the tank.
 */

/** Resolve an order the driver is genuinely holding, or 404. */
const resolveOrder = async ({ userId, orderId }) => {
  const driver = await resolveDriverProfile(userId);

  const order = await driverOrderRepository.findOrderForDriver({
    driverProfileId: driver.id,
    orderId,
  });

  if (!order) {
    // 404, not 403: a 403 would confirm the order exists (docs/10 §6).
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  return { driver, order };
};

const assertStatus = (order, expected) => {
  if (order.status !== expected) {
    throw new ConflictError(`This order is ${order.status}, not ${expected}`, {
      code: ERROR_CODES.INVALID_STATE_TRANSITION,
      details: { currentStatus: order.status },
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Trip progression                                                           */
/* -------------------------------------------------------------------------- */

/** ASSIGNED → EN_ROUTE. The driver has begun travelling. */
export const startTrip = async ({ userId, orderId, requestId }) => {
  const { order } = await resolveOrder({ userId, orderId });
  assertStatus(order, ORDER_STATUS.ASSIGNED);

  return transitionOrder({
    orderId,
    toStatus: ORDER_STATUS.EN_ROUTE,
    actorKind: ACTOR_KIND.DRIVER,
    actorUserId: userId,
    reason: 'Driver started the trip',
    expectedStatus: ORDER_STATUS.ASSIGNED,
    requestId,
  });
};

/** EN_ROUTE → ARRIVED. Geofence entry, or the driver tapped arrived. */
export const markArrived = async ({ userId, orderId, latitude, longitude, requestId }) => {
  const { order } = await resolveOrder({ userId, orderId });
  assertStatus(order, ORDER_STATUS.EN_ROUTE);

  /**
   * BR-912: the capture location is compared against the ordered address, and a
   * deviation is FLAGGED — never blocked. The fuel still has to be delivered,
   * and a driver parked forty metres away with a hose across a yard is normal.
   */
  const deviation = computeDeviation(order.addressSnapshot, latitude, longitude);

  return transitionOrder({
    orderId,
    toStatus: ORDER_STATUS.ARRIVED,
    actorKind: ACTOR_KIND.DRIVER,
    actorUserId: userId,
    reason: 'Driver arrived at the site',
    expectedStatus: ORDER_STATUS.EN_ROUTE,
    metadata: {
      ...(latitude !== undefined && longitude !== undefined
        ? { capturedAt: { latitude, longitude } }
        : {}),
      ...(deviation !== null ? { deviationMetres: deviation } : {}),
    },
    requestId,
  });
};

/** Straight-line distance in metres, or null when either point is unknown. */
const computeDeviation = (addressSnapshot, latitude, longitude) => {
  const lat = Number(addressSnapshot?.latitude);
  const lng = Number(addressSnapshot?.longitude);

  if (
    latitude === undefined ||
    longitude === undefined ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }

  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(latitude - lat);
  const dLng = toRad(longitude - lng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat)) * Math.cos(toRad(latitude)) * Math.sin(dLng / 2) ** 2;

  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
};

/* -------------------------------------------------------------------------- */
/* Opening reading                                                            */
/* -------------------------------------------------------------------------- */

/**
 * ARRIVED → DISPENSING, capturing the opening totaliser.
 *
 * The receiver must already have been verified. `receiverVerification` carries
 * how — OTP, or the documented fallback (BR-911). OTP is never the only path:
 * a dead customer phone must not strand a tanker.
 */
export const startDispensing = async ({
  userId,
  orderId,
  openingTotalizer,
  photoKey,
  receiverVerification,
  requestId,
}) => {
  const { order } = await resolveOrder({ userId, orderId });
  assertStatus(order, ORDER_STATUS.ARRIVED);

  const vehicleId = order.reservations?.[0]?.vehicleId;

  if (!vehicleId) {
    throw new ConflictError('This order holds no fuel reservation', {
      code: ERROR_CODES.RESERVATION_NOT_HELD,
    });
  }

  const existing = await driverOrderRepository.listDeliveryReadings(orderId);

  if (existing.some((r) => r.readingType === METER_READING_TYPE.DELIVERY_START)) {
    throw new ConflictError('An opening reading has already been recorded', {
      code: ERROR_CODES.CONFLICT,
    });
  }

  /**
   * BR-906: a manually entered reading requires a photograph of the meter.
   * Phase 1 is manual-only, so this is effectively mandatory on every delivery.
   */
  if (!photoKey) {
    throw new BadRequestError('A photograph of the meter is required', {
      code: ERROR_CODES.METER_PHOTO_REQUIRED,
    });
  }

  await prisma.meterReading.create({
    data: {
      vehicleId,
      orderId,
      readingType: METER_READING_TYPE.DELIVERY_START,
      totalizer: String(openingTotalizer),
      source: METER_READING_SOURCE.MANUAL_ENTRY,
      photoKey,
      recordedByUserId: userId,
      notes: receiverVerification?.method
        ? `Receiver verified by ${receiverVerification.method}`
        : null,
    },
  });

  const transitioned = await transitionOrder({
    orderId,
    toStatus: ORDER_STATUS.DISPENSING,
    actorKind: ACTOR_KIND.DRIVER,
    actorUserId: userId,
    reason: 'Receiver verified, opening reading captured',
    expectedStatus: ORDER_STATUS.ARRIVED,
    metadata: {
      openingTotalizer: String(openingTotalizer),
      receiverVerification: receiverVerification ?? null,
    },
    requestId,
  });

  log.info({ orderId, vehicleId, openingTotalizer }, 'dispensing started');

  return transitioned;
};

/* -------------------------------------------------------------------------- */
/* Completion                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The quantity calculation, isolated and pure so it can be tested exhaustively.
 *
 * Returns the billed quantity and whether a rollover was applied, or an error
 * code the caller turns into a rejection. The two failure shapes are kept
 * distinct because the driver app must say different things:
 *
 *   ROLLOVER  "That looks like the meter wrapping past its maximum" — accepted
 *   FAULT     "Closing is below opening" — rejected, ops must resolve
 */
export const computeDeliveredQuantity = ({ opening, closing, meterMaximum = null }) => {
  const open = Number(opening);
  const close = Number(closing);

  if (!Number.isFinite(open) || !Number.isFinite(close)) {
    return { ok: false, code: 'INVALID_READING' };
  }

  if (close >= open) {
    return { ok: true, quantity: close - open, rollover: false };
  }

  /**
   * BR-904: a genuine rollover is only credible when a meter maximum is
   * configured AND the wrapped figure is plausible. Without a maximum there is
   * no way to distinguish a wrap from a transposed digit, so it is a fault.
   */
  if (meterMaximum === null) {
    return { ok: false, code: 'METER_READING_REGRESSION' };
  }

  const max = Number(meterMaximum);
  const wrapped = max - open + close;

  if (!Number.isFinite(max) || wrapped <= 0 || wrapped > max) {
    return { ok: false, code: 'METER_READING_REGRESSION' };
  }

  return { ok: true, quantity: wrapped, rollover: true };
};

/**
 * Record the completed delivery.
 *
 * IDEMPOTENT ON `clientDeliveryId` (BR-914). The driver app generates that id
 * once, when the delivery is captured, and reuses it on every retry — which is
 * the entire point. A resubmission after a timeout returns the ORIGINAL result
 * rather than dispensing the fuel twice in the books.
 */
export const completeDelivery = async ({
  userId,
  orderId,
  clientDeliveryId,
  closingTotalizer,
  photoKey,
  outcome,
  reasonCode,
  notes,
  temperatureC,
  requestId,
}) => {
  const { order } = await resolveOrder({ userId, orderId });

  const readings = await driverOrderRepository.listDeliveryReadings(orderId);

  /**
   * The replay check comes FIRST, before any state assertion.
   *
   * A retry arrives when the order is already DELIVERED, so asserting
   * DISPENSING first would reject exactly the request idempotency exists to
   * absorb — and the driver app, offline, would keep retrying forever.
   */
  const alreadyClosed = readings.find(
    (r) => r.readingType === METER_READING_TYPE.DELIVERY_END && r.notes?.includes(clientDeliveryId)
  );

  if (alreadyClosed) {
    log.info({ orderId, clientDeliveryId }, 'duplicate delivery submission — returning original');
    return { order, replayed: true };
  }

  assertStatus(order, ORDER_STATUS.DISPENSING);

  const opening = readings.find((r) => r.readingType === METER_READING_TYPE.DELIVERY_START);

  if (!opening) {
    throw new ConflictError('No opening reading was recorded for this delivery', {
      code: ERROR_CODES.CONFLICT,
    });
  }

  if (!photoKey) {
    throw new BadRequestError('A photograph of the closing meter is required', {
      code: ERROR_CODES.METER_PHOTO_REQUIRED,
    });
  }

  const vehicleId = order.reservations?.[0]?.vehicleId;

  // FAILED bills nothing (BR-921), so no quantity is computed for it.
  let deliveredQuantity = 0;
  let rollover = false;

  if (outcome !== 'FAILED') {
    const result = computeDeliveredQuantity({
      opening: opening.totalizer,
      closing: closingTotalizer,
      meterMaximum: null,
    });

    if (!result.ok) {
      throw new BadRequestError(
        `Closing reading ${closingTotalizer} is below the opening reading ${opening.totalizer}. ` +
          'Check for a meter reset or a transposed digit.',
        {
          code: ERROR_CODES.METER_READING_REGRESSION,
          details: { opening: String(opening.totalizer), closing: String(closingTotalizer) },
        }
      );
    }

    deliveredQuantity = result.quantity;
    rollover = result.rollover;
  }

  const ordered = Number(order.quantity);

  /**
   * The outcome is DERIVED from the readings, not taken on trust.
   *
   * A driver's stated outcome is a claim; closing minus opening is evidence.
   * Where they disagree, the evidence wins — that is the whole reason the
   * quantity comes from two readings rather than a field.
   */
  const derivedStatus =
    outcome === 'FAILED'
      ? ORDER_STATUS.DELIVERY_FAILED
      : deliveredQuantity >= ordered
        ? ORDER_STATUS.DELIVERED
        : ORDER_STATUS.PARTIALLY_DELIVERED;

  if (outcome !== 'FAILED') {
    await prisma.meterReading.create({
      data: {
        vehicleId,
        orderId,
        readingType: METER_READING_TYPE.DELIVERY_END,
        totalizer: String(closingTotalizer),
        grossQuantity: String(deliveredQuantity),
        // Net is what is billed (BR-905). With no temperature probe in Phase 1
        // it equals gross; the column exists so compensation can arrive later
        // without a migration.
        netQuantity: String(deliveredQuantity),
        temperatureC: temperatureC === undefined ? null : String(temperatureC),
        source: METER_READING_SOURCE.MANUAL_ENTRY,
        photoKey,
        recordedByUserId: userId,
        // The client id lives here so a replay is detectable without a new table.
        notes: `delivery:${clientDeliveryId}${notes ? ` · ${notes}` : ''}`,
      },
    });
  }

  const transitioned = await transitionOrder({
    orderId,
    toStatus: derivedStatus,
    actorKind: ACTOR_KIND.DRIVER,
    actorUserId: userId,
    reason:
      outcome === 'FAILED'
        ? `Delivery failed: ${reasonCode ?? 'unspecified'}`
        : derivedStatus === ORDER_STATUS.PARTIALLY_DELIVERED
          ? `Partial delivery: ${reasonCode ?? 'unspecified'}`
          : 'Delivered in full',
    expectedStatus: ORDER_STATUS.DISPENSING,
    metadata: {
      clientDeliveryId,
      openingTotalizer: String(opening.totalizer),
      closingTotalizer: String(closingTotalizer),
      deliveredQuantity: String(deliveredQuantity),
      orderedQuantity: String(ordered),
      outcome,
      reasonCode: reasonCode ?? null,
      rollover,
    },
    requestId,
  });

  /**
   * The delivered quantity is written to the ORDER so the invoice can be built
   * from it. Reconciliation — refunding the difference on a partial, collecting
   * on an over-delivery — belongs to the settlement module, which does not
   * exist yet. The order is deliberately left with `settlementStatus` untouched
   * rather than marked settled, so nothing downstream mistakes it for resolved.
   */
  if (outcome !== 'FAILED') {
    await prisma.order.update({
      where: { id: orderId },
      data: {
        deliveredQuantity: String(deliveredQuantity),
        ...(deliveredQuantity !== ordered ? { settlementStatus: 'PENDING' } : {}),
      },
    });
  }

  log.info(
    { orderId, clientDeliveryId, deliveredQuantity, outcome, derivedStatus, rollover },
    'delivery recorded'
  );

  return { order: transitioned, replayed: false, deliveredQuantity, rollover };
};
