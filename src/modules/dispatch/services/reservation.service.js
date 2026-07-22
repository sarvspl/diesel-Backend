import { env } from '../../../config/env.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { RESERVATION_RELEASE_REASON, RESERVATION_STATUS } from '../../../shared/constants/order.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import { toQuantityString } from '../../../shared/utils/money.js';
import * as vehicleRepository from '../../fleet/repositories/vehicle.repository.js';
import { assessDispatchability } from '../../fleet/services/dispatchability.service.js';
import * as reservationRepository from '../repositories/reservation.repository.js';

const log = createLogger({ module: 'dispatch.reservation' });

/**
 * Refuse a vehicle that is legally unable to take a delivery.
 *
 * Calls INTO Fleet through its published seam rather than re-reading
 * compliance columns here. Fleet answers "is this vehicle capable and
 * compliant"; Dispatch decides "which capable vehicle gets this order"
 * (docs/06 §6). Duplicating the rule would let the two drift, and the copy
 * that drifts is the one that lets an uncalibrated tanker out.
 */
const assertVehicleDispatchable = async (vehicleId) => {
  const vehicle = await vehicleRepository.findById(vehicleId);

  if (!vehicle) {
    throw new NotFoundError('Vehicle not found');
  }

  const { hardBlockers } = assessDispatchability({
    vehicle,
    inventory: vehicle.inventory,
    // Not asserted here. A missing driver is a SOFT blocker, and the fuel can
    // legitimately be held before a driver is paired with the tanker.
    hasActiveDriver: true,
  });

  if (hardBlockers.length > 0) {
    throw new ConflictError('That vehicle cannot take a delivery', {
      code: ERROR_CODES.VEHICLE_NOT_DISPATCHABLE,
      details: { vehicleId, hardBlockers },
    });
  }
};

/**
 * Reserving fuel against a vehicle (BR-405 - BR-408).
 *
 * A reservation is a PROMISE, not a withdrawal. It says "these litres are
 * spoken for" without moving them, because the amount that eventually moves is
 * the amount actually dispensed, which is routinely not the amount ordered
 * (ADR-009). Deducting at reservation time would make every partial delivery a
 * correction.
 *
 * The invariants this upholds:
 *   INV-03  held >= 0, available >= 0, held == sum of active reservations
 *   INV-06  an order has at most one active reservation
 */

/**
 * The internal shape. NEVER returned to a customer.
 *
 * "Never expose internal reservation details to customers": which tanker holds
 * their fuel, how much slack it has and which vehicles were considered are
 * operational facts. A customer knowing their order sits on vehicle X learns
 * something about fleet capacity that is none of their business.
 */
const toAdminReservation = (reservation) => ({
  id: reservation.id,
  orderId: reservation.orderId,
  vehicleId: reservation.vehicleId,
  quantity: toQuantityString(reservation.quantity),
  status: reservation.status,
  expiresAt: reservation.expiresAt,
  releasedAt: reservation.releasedAt,
  releaseReason: reservation.releaseReason,
  consumedQuantity:
    reservation.consumedQuantity === null ? null : toQuantityString(reservation.consumedQuantity),
  createdAt: reservation.createdAt,
});

const expiryFrom = (now = new Date()) =>
  new Date(now.getTime() + env.RESERVATION_TTL_MINUTES * 60_000);

/**
 * Hold fuel for an order.
 *
 * If no vehicle is named, the first vehicle with enough slack is chosen. That
 * is NOT allocation - allocation ranks candidates by travel time, checks
 * calibration, licences, driver availability and zone coverage, and belongs to
 * the dispatch module proper (docs/07 §4). This picks any vehicle that can
 * physically hold the promise, which is all a reservation requires.
 *
 * INV-06 is enforced first: an order already holding fuel does not get a second
 * claim, or `held` would double-count and the tanker would appear fuller than
 * it is.
 */
export const reserve = async ({ orderId, quantity, vehicleId = null, actorUserId = null }) => {
  const existing = await reservationRepository.findActiveForOrder(orderId);

  if (existing) {
    throw new ConflictError('That order already holds a fuel reservation', {
      code: ERROR_CODES.RESERVATION_ALREADY_HELD,
      details: { reservationId: existing.id },
    });
  }

  const expiresAt = expiryFrom();

  if (vehicleId) {
    /**
     * A NAMED vehicle is checked for compliance before its fuel is committed.
     *
     * Without this the endpoint will happily hold fuel on a tanker whose
     * calibration certificate has lapsed, which is a Legal Metrology offence
     * (BR-402) and not something an operator may authorise. The admin UI
     * refuses it, but a UI is not an enforcement boundary - anything reachable
     * over HTTP has to defend itself.
     *
     * Only HARD blockers refuse. Soft ones (a stale fuel reading, no driver
     * yet) are exactly the cases a human is allowed to override with a reason,
     * and the manual-assignment flow records that reason on the timeline
     * (docs/04 §19).
     *
     * The unnamed-vehicle path below deliberately does not run this: it picks
     * whatever can physically hold the promise and is not an assignment. Real
     * allocation belongs to the dispatch module, which does not exist yet.
     */
    await assertVehicleDispatchable(vehicleId);

    const result = await reservationRepository.hold({
      orderId,
      vehicleId,
      quantity,
      expiresAt,
      createdByUserId: actorUserId,
    });

    if (!result.ok) throw reservationFailure(result);

    log.info(
      { orderId, vehicleId, quantity: String(quantity), reservationId: result.reservation.id },
      'fuel reserved'
    );

    return result.reservation;
  }

  const candidates = await reservationRepository.findCandidateVehicles({ quantity });

  if (candidates.length === 0) {
    throw new ConflictError('No vehicle currently has enough fuel for this order', {
      code: ERROR_CODES.NO_VEHICLE_AVAILABLE,
      details: { requested: toQuantityString(quantity) },
    });
  }

  /**
   * Try each candidate in turn.
   *
   * The list was read OUTSIDE any lock, so a candidate may have been claimed
   * between the read and the attempt. That is not an error - it is the race
   * working correctly, and the right response is to try the next vehicle rather
   * than fail the order. Only running out of candidates is a real failure.
   */
  for (const candidate of candidates) {
    const result = await reservationRepository.hold({
      orderId,
      vehicleId: candidate.vehicleId,
      quantity,
      expiresAt,
      createdByUserId: actorUserId,
    });

    if (result.ok) {
      log.info(
        { orderId, vehicleId: candidate.vehicleId, reservationId: result.reservation.id },
        'fuel reserved'
      );

      return result.reservation;
    }

    log.debug(
      { orderId, vehicleId: candidate.vehicleId, code: result.code },
      'candidate vehicle lost the race, trying the next'
    );
  }

  throw new ConflictError('No vehicle currently has enough fuel for this order', {
    code: ERROR_CODES.NO_VEHICLE_AVAILABLE,
    details: { requested: toQuantityString(quantity) },
  });
};

const reservationFailure = (result) => {
  if (result.code === 'NO_INVENTORY') {
    return new NotFoundError('That vehicle has no inventory record');
  }

  return new ConflictError('That vehicle does not have enough unreserved fuel', {
    code: ERROR_CODES.INSUFFICIENT_FUEL,
    details: result.details,
  });
};

/**
 * Give the litres back.
 *
 * Idempotent by design: releasing an already-released reservation succeeds
 * quietly rather than throwing. The cancel endpoint and the expiry sweeper race
 * each other routinely, and a customer's cancellation must not fail because a
 * background job got there a millisecond earlier.
 */
export const release = async ({
  reservationId,
  reason = RESERVATION_RELEASE_REASON.ADMIN_RELEASE,
  status = RESERVATION_STATUS.RELEASED,
}) => {
  const result = await reservationRepository.settle({
    reservationId,
    finalStatus: status,
    reason,
  });

  if (!result.ok && result.code === 'NOT_FOUND') {
    throw new NotFoundError('Reservation not found', {
      code: ERROR_CODES.RESERVATION_NOT_FOUND,
    });
  }

  if (!result.ok) {
    log.info({ reservationId, reason }, 'reservation was already settled');
    return result.reservation;
  }

  log.info({ reservationId, reason, status }, 'fuel reservation released');

  return result.reservation;
};

/** Release whatever an order is holding, if anything. Safe to call blindly. */
export const releaseForOrder = async ({ orderId, reason, status }) => {
  const active = await reservationRepository.findActiveForOrder(orderId);

  if (!active) return null;

  return release({ reservationId: active.id, reason, status });
};

/**
 * Release every reservation past its expiry (BR-407).
 *
 * Intended for a scheduled sweep. No scheduler exists yet, and when one does it
 * must be SINGLETON across instances - two sweepers releasing the same
 * reservation is the named trigger for needing a distributed lock
 * (docs/08 §9.6). The conditional claim inside `settle` means the worst case
 * today is wasted work rather than double-counted litres.
 */
export const sweepExpired = async () => {
  const lapsed = await reservationRepository.findLapsed();
  let released = 0;

  for (const reservation of lapsed) {
    const result = await reservationRepository.settle({
      reservationId: reservation.id,
      finalStatus: RESERVATION_STATUS.EXPIRED,
      reason: RESERVATION_RELEASE_REASON.SWEPT_EXPIRED,
    });

    if (result.ok) released += 1;
  }

  if (released > 0) log.info({ released }, 'expired fuel reservations swept');

  return { released, examined: lapsed.length };
};

export const findActiveForOrder = reservationRepository.findActiveForOrder;
export const listForOrder = reservationRepository.listForOrder;
export const findById = reservationRepository.findById;
export const sumHeldForVehicle = reservationRepository.sumHeldForVehicle;
export { toAdminReservation };
