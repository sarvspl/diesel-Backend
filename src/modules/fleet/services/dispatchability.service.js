import { DISPATCH_BLOCKER, VEHICLE_STATUS } from '../../../shared/constants/fleet.js';

/**
 * Can this vehicle take a delivery?
 *
 * THE SEAM BETWEEN FLEET AND DISPATCH (docs/06 §6).
 *
 * Fleet answers "is this vehicle capable and compliant". Dispatch decides
 * "which capable vehicle gets this order". Putting allocation policy here, or
 * compliance rules there, is the boundary violation that turns a modular
 * monolith back into a ball of mud.
 *
 * PURE FUNCTION. No database, no clock of its own - `now` is a parameter so
 * every expiry boundary is testable exactly, including the day a certificate
 * lapses. Dispatch does not exist yet; this is what it will call.
 *
 * BR-402 is the reason this is not merely advisory: dispensing on a vehicle
 * whose calibration certificate has expired is a Legal Metrology offence, not
 * a policy preference. HARD blockers cannot be overridden by an operator;
 * SOFT ones can, with a reason (docs/04 §19).
 */

/** Blockers an operator may override when manually assigning. */
const SOFT_BLOCKERS = new Set([
  DISPATCH_BLOCKER.FUEL_STATE_STALE,
  DISPATCH_BLOCKER.NO_DRIVER_ASSIGNED,
  DISPATCH_BLOCKER.PUC_EXPIRED,
]);

/**
 * A date-only expiry lapses at the END of its day. Treating `expiry < now`
 * as expired would invalidate a certificate on the morning of the day it is
 * still valid.
 */
const hasExpired = (expiry, now) => {
  if (!expiry) return false;

  const endOfExpiryDay = new Date(expiry);
  endOfExpiryDay.setUTCHours(23, 59, 59, 999);

  return endOfExpiryDay < now;
};

/**
 * @param {object} input
 * @param {object} input.vehicle           Vehicle row.
 * @param {object} [input.inventory]       VehicleInventory row, if loaded.
 * @param {boolean} [input.hasActiveDriver]
 * @param {Date} [input.now]
 * @returns {{ dispatchable: boolean, blockers: string[], hardBlockers: string[], softBlockers: string[] }}
 */
export const assessDispatchability = ({
  vehicle,
  inventory = null,
  hasActiveDriver = false,
  now = new Date(),
}) => {
  const blockers = [];

  if (vehicle.status === VEHICLE_STATUS.RETIRED) {
    blockers.push(DISPATCH_BLOCKER.RETIRED);
  } else if (vehicle.status !== VEHICLE_STATUS.ACTIVE) {
    // MAINTENANCE and INACTIVE (BR-403).
    blockers.push(DISPATCH_BLOCKER.NOT_ACTIVE);
  }

  // BR-402 - the two that are legally, not operationally, disqualifying.
  if (hasExpired(vehicle.calibrationExpiry, now)) {
    blockers.push(DISPATCH_BLOCKER.CALIBRATION_EXPIRED);
  }

  if (hasExpired(vehicle.pesoLicenseExpiry, now)) {
    blockers.push(DISPATCH_BLOCKER.PESO_EXPIRED);
  }

  // Driving an uninsured or unroadworthy tanker is a separate legal problem.
  if (hasExpired(vehicle.insuranceExpiry, now)) {
    blockers.push(DISPATCH_BLOCKER.INSURANCE_EXPIRED);
  }

  if (hasExpired(vehicle.fitnessExpiry, now)) {
    blockers.push(DISPATCH_BLOCKER.FITNESS_EXPIRED);
  }

  // Soft: an emissions certificate lapsing is a compliance task, not a reason
  // to strand a customer mid-shift.
  if (hasExpired(vehicle.pucExpiry, now)) {
    blockers.push(DISPATCH_BLOCKER.PUC_EXPIRED);
  }

  if (!hasActiveDriver) {
    blockers.push(DISPATCH_BLOCKER.NO_DRIVER_ASSIGNED);
  }

  if (inventory) {
    // BR-409: past its staleness horizon the figure is unverified, so treating
    // it as fact risks dispatching a tanker that is actually empty.
    if (inventory.staleAfter && new Date(inventory.staleAfter) < now) {
      blockers.push(DISPATCH_BLOCKER.FUEL_STATE_STALE);
    }

    // Available = current − held (BR-405). Nothing writes `held` yet.
    const available = Number(inventory.currentQuantity) - Number(inventory.heldQuantity);

    if (available <= 0) {
      blockers.push(DISPATCH_BLOCKER.NO_AVAILABLE_FUEL);
    }
  }

  const hardBlockers = blockers.filter((code) => !SOFT_BLOCKERS.has(code));
  const softBlockers = blockers.filter((code) => SOFT_BLOCKERS.has(code));

  return {
    dispatchable: blockers.length === 0,
    blockers,
    hardBlockers,
    softBlockers,
  };
};

/**
 * Whether a driver may start a shift on this vehicle.
 *
 * Stricter than dispatchability in one way and looser in another: a shift may
 * begin with an empty tank (the driver is going to a depot to refill) and with
 * no assignment yet (starting the shift is what creates one), but never on a
 * vehicle whose calibration or PESO licence has lapsed.
 */
export const assertVehicleUsableForShift = ({ vehicle, now = new Date() }) => {
  const { hardBlockers } = assessDispatchability({
    vehicle,
    inventory: null,
    hasActiveDriver: true,
    now,
  });

  return { usable: hardBlockers.length === 0, blockers: hardBlockers };
};
