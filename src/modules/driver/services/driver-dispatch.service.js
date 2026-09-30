import { env } from '../../../config/env.js';
import { prisma } from '../../../infrastructure/database/prisma.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { DRIVER_EMPLOYMENT_STATUS } from '../../../shared/constants/fleet.js';
import {
  ACTOR_KIND,
  ORDER_STATUS,
  RESERVATION_RELEASE_REASON,
  RESERVATION_STATUS,
} from '../../../shared/constants/order.js';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import { toMoneyString, toQuantityString } from '../../../shared/utils/money.js';
import * as reservationService from '../../dispatch/services/reservation.service.js';
import {
  destinationOf,
  recordDriverLocation,
  routeBetween,
} from '../../dispatch/services/tracking.service.js';
import { transitionOrder } from '../../order/services/transition-order.service.js';
import * as driverOrderRepository from '../repositories/driver-order.repository.js';

import { resolveDriverProfile } from './driver-self.service.js';

const log = createLogger({ module: 'driver.dispatch' });

/**
 * Driver self-dispatch: nearby open orders, first to accept wins.
 *
 * A stand-in for a real allocation engine (docs/07 §4), which would rank
 * tankers by travel time and offer to one at a time. Here every driver with a
 * tanker sees every open order within DISPATCH_NEARBY_RADIUS_KM of their phone,
 * by straight-line distance, and the order goes to whoever accepts first.
 *
 * FIRST-WINS is the order-status compare-and-set in `transitionOrder`
 * (CONFIRMED → ALLOCATING with `expectedStatus`): exactly one request matches
 * the row; the rest get ORDER_ALREADY_TAKEN.
 *
 * THE FUEL FOLLOWS THE DRIVER. Placement already held the fuel on whichever
 * tanker had room (create-order.service.js). Accepting moves that hold onto the
 * accepting driver's tanker, because the reservation is what links an order to
 * a driver (driver-order.repository.js).
 */

/** Orders a driver may pick up. ALLOCATION_FAILED = a previous accept fell through. */
const OPEN_STATUSES = [ORDER_STATUS.CONFIRMED, ORDER_STATUS.ALLOCATION_FAILED];

/** How many open orders are scanned for distance. Plenty at current volume. */
const SCAN_LIMIT = 300;

const distanceKm = (lat1, lng1, lat2, lng2) => {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const assertCanWork = (driver) => {
  if (driver.employmentStatus !== DRIVER_EMPLOYMENT_STATUS.ACTIVE) {
    throw new ForbiddenError('This driver account is not active', {
      code: ERROR_CODES.DRIVER_NOT_ACTIVE,
    });
  }
};

const requireVehicle = async (driverProfileId) => {
  const vehicleId = await driverOrderRepository.findActiveVehicleIdForDriver(driverProfileId);

  if (!vehicleId) {
    throw new ConflictError('No tanker is assigned to you. Ask the admin to assign one.', {
      code: ERROR_CODES.VEHICLE_NOT_ASSIGNED,
    });
  }

  return vehicleId;
};

/**
 * What a driver sees BEFORE accepting: enough to decide (how much, how far,
 * which area, cash to collect) and nothing identifying the customer. Name,
 * phone and the exact address come with the order once it is theirs.
 */
const toRequest = (order, km) => ({
  id: order.id,
  orderNumber: order.orderNumber,
  quantity: toQuantityString(order.quantity),
  product: order.productSnapshot
    ? { name: order.productSnapshot.name ?? null, code: order.productSnapshot.code ?? null }
    : null,
  paymentMode: order.paymentMode,
  amountToCollect:
    order.paymentMode === 'CASH_ON_DELIVERY'
      ? toMoneyString(order.finalTotalAmount ?? order.totalAmount)
      : null,
  area: {
    landmark: order.addressSnapshot?.landmark ?? null,
    city: order.addressSnapshot?.city ?? order.city ?? null,
    pincode: order.addressSnapshot?.pincode ?? null,
  },
  distanceKm: Math.round(km * 10) / 10,
  scheduledFor: order.scheduledFor ?? null,
  placedAt: order.placedAt,
});

/**
 * Open orders near the driver, nearest first.
 *
 * Also remembers the position on the driver's open shift, which is the only
 * place the platform keeps a driver location today.
 */
export const listNearbyRequests = async ({ userId, latitude, longitude }) => {
  const driver = await resolveDriverProfile(userId);
  const radiusKm = env.DISPATCH_NEARBY_RADIUS_KM;

  await recordDriverLocation({ driverProfileId: driver.id, latitude, longitude });

  const vehicleId = await driverOrderRepository.findActiveVehicleIdForDriver(driver.id);

  // No tanker, nothing to deliver with. Not an error: the screen explains it.
  if (!vehicleId) return { requests: [], radiusKm, hasVehicle: false };

  const candidates = await prisma.order.findMany({
    where: { status: { in: OPEN_STATUSES } },
    select: {
      id: true,
      orderNumber: true,
      quantity: true,
      paymentMode: true,
      totalAmount: true,
      finalTotalAmount: true,
      city: true,
      addressSnapshot: true,
      productSnapshot: true,
      scheduledFor: true,
      placedAt: true,
    },
    orderBy: { placedAt: 'asc' },
    take: SCAN_LIMIT,
  });

  const requests = [];

  for (const order of candidates) {
    const lat = Number(order.addressSnapshot?.latitude);
    const lng = Number(order.addressSnapshot?.longitude);

    // An order with no coordinates cannot be "nearby"; the admin assigns it.
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const km = distanceKm(latitude, longitude, lat, lng);
    if (km <= radiusKm) requests.push(toRequest(order, km));
  }

  requests.sort((a, b) => a.distanceKm - b.distanceKm);

  return { requests, radiusKm, hasVehicle: true };
};

/** Free (unreserved) litres on a tanker, read without a lock: a pre-check only. */
const freeLitres = async (vehicleId) => {
  const inventory = await prisma.vehicleInventory.findUnique({
    where: { vehicleId },
    select: { currentQuantity: true, heldQuantity: true },
  });

  if (!inventory) return 0;
  return Number(inventory.currentQuantity) - Number(inventory.heldQuantity);
};

/**
 * Accept an open order onto the driver's tanker.
 *
 * Sequence, and why:
 *   1. Pre-checks (tanker, fuel) BEFORE claiming, so the common failure does
 *      not leave the order half-moved.
 *   2. Claim: CONFIRMED/ALLOCATION_FAILED → ALLOCATING. The first-wins point.
 *   3. Move the fuel hold to this tanker (release old, hold new). The one-HELD-
 *      per-order unique index forbids holding the new one first.
 *   4. ALLOCATING → ASSIGNED. The order now appears in the driver's list.
 *
 * If step 3 fails (fuel went elsewhere in the gap), the old hold is restored
 * where possible and the order goes to ALLOCATION_FAILED, which keeps it
 * visible to other nearby drivers and to the admin.
 */
export const acceptRequest = async ({ userId, orderId, requestId }) => {
  const driver = await resolveDriverProfile(userId);
  assertCanWork(driver);
  const vehicleId = await requireVehicle(driver.id);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      quantity: true,
      reservations: {
        where: { status: RESERVATION_STATUS.HELD },
        select: { id: true, vehicleId: true },
      },
    },
  });

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  if (!OPEN_STATUSES.includes(order.status)) {
    throw new ConflictError('Another driver has already taken this order', {
      code: ERROR_CODES.ORDER_ALREADY_TAKEN,
    });
  }

  const held = order.reservations[0] ?? null;
  const mustMove = !held || held.vehicleId !== vehicleId;

  if (mustMove && (await freeLitres(vehicleId)) < Number(order.quantity)) {
    throw new ConflictError('Your tanker does not have enough free fuel for this order', {
      code: ERROR_CODES.INSUFFICIENT_FUEL,
      details: { requested: toQuantityString(order.quantity) },
    });
  }

  // --- 2. Claim ------------------------------------------------------------
  try {
    await transitionOrder({
      orderId,
      toStatus: ORDER_STATUS.ALLOCATING,
      actorKind: ACTOR_KIND.SYSTEM,
      reason: 'A nearby driver accepted the order',
      expectedStatus: order.status,
      metadata: { acceptedByDriverUserId: userId, vehicleId },
      requestId,
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      throw new ConflictError('Another driver has already taken this order', {
        code: ERROR_CODES.ORDER_ALREADY_TAKEN,
      });
    }
    throw err;
  }

  // --- 3. Move the fuel ----------------------------------------------------
  if (mustMove) {
    if (held) {
      await reservationService.release({
        reservationId: held.id,
        reason: RESERVATION_RELEASE_REASON.REALLOCATION,
      });
    }

    try {
      await reservationService.reserve({
        orderId,
        quantity: order.quantity,
        vehicleId,
        actorUserId: userId,
      });
    } catch (err) {
      log.warn({ orderId, vehicleId, err: err.message }, 'accept: could not move fuel hold');

      if (held) {
        await reservationService
          .reserve({ orderId, quantity: order.quantity, vehicleId: held.vehicleId })
          .catch((e) => log.error({ orderId, err: e.message }, 'accept: could not restore hold'));
      }

      await transitionOrder({
        orderId,
        toStatus: ORDER_STATUS.ALLOCATION_FAILED,
        actorKind: ACTOR_KIND.SYSTEM,
        reason: 'Accepting driver could not take the fuel reservation',
        expectedStatus: ORDER_STATUS.ALLOCATING,
        metadata: { vehicleId, error: err.code ?? err.message },
        requestId,
      });

      throw err instanceof AppError
        ? err
        : new ConflictError('Could not move the fuel to your tanker', {
            code: ERROR_CODES.INSUFFICIENT_FUEL,
          });
    }
  }

  // --- 4. Assigned ---------------------------------------------------------
  const assigned = await transitionOrder({
    orderId,
    toStatus: ORDER_STATUS.ASSIGNED,
    actorKind: ACTOR_KIND.SYSTEM,
    reason: 'Assigned to the accepting driver',
    expectedStatus: ORDER_STATUS.ALLOCATING,
    metadata: { driverUserId: userId, vehicleId },
    requestId,
  });

  log.info({ orderId, vehicleId, driverUserId: userId }, 'order accepted by driver');

  return driverOrderRepository
    .findOrderForDriver({ driverProfileId: driver.id, orderId })
    .then((o) => o ?? assigned);
};

/** The phone's position, reported while the app is open on a trip screen. */
export const updateLocation = async ({ userId, latitude, longitude }) => {
  const driver = await resolveDriverProfile(userId);
  await recordDriverLocation({ driverProfileId: driver.id, latitude, longitude });
};

/**
 * Road route from where the driver is to the order's delivery point, for the
 * in-app map. Also records the position, so the customer's map moves.
 */
export const routeToOrder = async ({ userId, orderId, latitude, longitude }) => {
  const driver = await resolveDriverProfile(userId);
  const order = await driverOrderRepository.findOrderForDriver({
    driverProfileId: driver.id,
    orderId,
  });

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  await recordDriverLocation({ driverProfileId: driver.id, latitude, longitude });

  const destination = destinationOf(order.addressSnapshot);
  const route = await routeBetween({ latitude, longitude }, destination);

  return { orderId, status: order.status, destination, route };
};

/**
 * Hand an accepted order back, before the trip starts.
 *
 * ASSIGNED → ALLOCATING → ALLOCATION_FAILED: the second state is one nearby
 * drivers can see and accept, so the order goes straight back to the pool.
 * The fuel hold stays on this tanker until the next driver's accept moves it.
 * Once the trip has started the driver must call dispatch instead: a customer
 * is expecting that tanker.
 */
export const rejectOrder = async ({ userId, orderId, reason, requestId }) => {
  const driver = await resolveDriverProfile(userId);
  const order = await driverOrderRepository.findOrderForDriver({
    driverProfileId: driver.id,
    orderId,
  });

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  if (order.status !== ORDER_STATUS.ASSIGNED) {
    throw new ConflictError('The trip has started. Call dispatch to hand this order back.', {
      code: ERROR_CODES.INVALID_STATE_TRANSITION,
      details: { currentStatus: order.status },
    });
  }

  await transitionOrder({
    orderId,
    toStatus: ORDER_STATUS.ALLOCATING,
    actorKind: ACTOR_KIND.SYSTEM,
    reason: reason ? `Driver handed the order back: ${reason}` : 'Driver handed the order back',
    expectedStatus: ORDER_STATUS.ASSIGNED,
    metadata: { rejectedByDriverUserId: userId },
    requestId,
  });

  await transitionOrder({
    orderId,
    toStatus: ORDER_STATUS.ALLOCATION_FAILED,
    actorKind: ACTOR_KIND.SYSTEM,
    reason: 'Returned to nearby drivers',
    expectedStatus: ORDER_STATUS.ALLOCATING,
    requestId,
  });

  log.info({ orderId, driverUserId: userId }, 'order handed back by driver');
};
