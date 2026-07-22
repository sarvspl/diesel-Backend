import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { DRIVER_AVAILABILITY, DRIVER_EMPLOYMENT_STATUS } from '../../../shared/constants/fleet.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as driverRepository from '../../fleet/repositories/driver.repository.js';
import * as vehicleRepository from '../../fleet/repositories/vehicle.repository.js';
import { assessDispatchability } from '../../fleet/services/dispatchability.service.js';
import * as driverOrderRepository from '../repositories/driver-order.repository.js';

const log = createLogger({ module: 'driver.self' });

/**
 * Driver self-service.
 *
 * THE RULE THIS MODULE IS BUILT ON: the driver profile is resolved from the
 * AUTHENTICATED TOKEN, never from a request parameter (BR-225). No endpoint
 * here accepts a `driverProfileId`, so there is no request a driver could
 * craft that reaches another driver's shift, orders or earnings.
 *
 * It reuses Fleet's shift logic rather than reimplementing it. Fleet already
 * enforces BR-304 (expired licence), BR-402 (calibration and PESO) and INV-07
 * (one open shift); a second copy here would drift, and the copy that drifts
 * is the one that lets an uncalibrated tanker onto the road.
 */

/** The caller's driver profile. Throws if this identity has none. */
export const resolveDriverProfile = async (userId) => {
  const driver = await driverRepository.findByUserId(userId);

  if (!driver) {
    throw new NotFoundError('No driver profile exists for this account', {
      code: ERROR_CODES.PROFILE_NOT_FOUND,
    });
  }

  return driver;
};

/**
 * Refuse a driver who may not work.
 *
 * Separate from credential checking so it runs on every driver action, not
 * only at login: an administrator suspending a driver mid-shift must stop
 * them at the next request, not whenever their token happens to lapse
 * (BR-312, BR-125).
 */
const assertEmployable = (driver) => {
  if (driver.employmentStatus !== DRIVER_EMPLOYMENT_STATUS.ACTIVE) {
    throw new ForbiddenError('This driver account is not active', {
      code: ERROR_CODES.DRIVER_NOT_ACTIVE,
      details: { employmentStatus: driver.employmentStatus },
    });
  }
};

const isLicenceExpired = (expiry) => {
  if (!expiry) return false;
  const endOfDay = new Date(expiry);
  endOfDay.setUTCHours(23, 59, 59, 999);
  return endOfDay < new Date();
};

/**
 * Everything the app needs on launch, in one call.
 *
 * Deliberately one round trip: the driver app opens in a plant room on a weak
 * connection, and three sequential requests to paint a home screen is three
 * chances to fail.
 */
export const getSelf = async (userId) => {
  const driver = await resolveDriverProfile(userId);

  const [openShift, assignment] = await Promise.all([
    driverRepository.findOpenShiftForDriver(driver.id),
    vehicleRepository.findActiveAssignmentForDriver(driver.id),
  ]);

  // The vehicle comes from the open shift when there is one, because that is
  // the tanker actually being operated. Falling back to the standing
  // assignment covers the pre-shift case.
  const vehicleId = openShift?.vehicleId ?? assignment?.vehicleId ?? null;
  const vehicle = vehicleId ? await vehicleRepository.findById(vehicleId) : null;

  const licenceExpired = isLicenceExpired(driver.licenseExpiry);

  /**
   * Blockers, computed server-side.
   *
   * The app renders these; it does not derive them. A client that decided for
   * itself whether a certificate had lapsed would be one timezone bug away
   * from putting an uncalibrated tanker on the road.
   */
  const blockers = [];

  if (driver.employmentStatus !== DRIVER_EMPLOYMENT_STATUS.ACTIVE) {
    blockers.push({
      code: 'DRIVER_NOT_ACTIVE',
      severity: 'HARD',
      message: 'Your account is not active. Contact operations.',
    });
  }

  if (licenceExpired) {
    blockers.push({
      code: 'DRIVER_LICENCE_EXPIRED',
      severity: 'HARD',
      message: 'Your driving licence has expired. It must be renewed before you can drive.',
      detail: driver.licenseExpiry,
    });
  }

  if (!vehicle) {
    blockers.push({
      code: 'NO_VEHICLE_ASSIGNED',
      severity: 'HARD',
      message: 'No vehicle is assigned to you. Contact operations.',
    });
  } else {
    const { hardBlockers } = assessDispatchability({
      vehicle,
      inventory: vehicle.inventory,
      hasActiveDriver: true,
    });

    for (const code of hardBlockers) {
      blockers.push({
        code,
        severity: 'HARD',
        message: BLOCKER_MESSAGE[code] ?? 'This vehicle cannot be operated.',
      });
    }
  }

  return {
    driver: toSelfDriver(driver),
    vehicle: vehicle ? toDriverVehicle(vehicle) : null,
    shift: openShift ? toSelfShift(openShift) : null,
    /// Empty means "you may start a shift". Non-empty means the app shows why not.
    blockers,
    canStartShift: blockers.length === 0 && !openShift,
  };
};

const BLOCKER_MESSAGE = {
  CALIBRATION_EXPIRED:
    'The meter calibration certificate on this vehicle has expired. It cannot dispense fuel.',
  PESO_LICENSE_EXPIRED: 'The PESO licence on this vehicle has expired.',
  INSURANCE_EXPIRED: 'Insurance on this vehicle has expired.',
  FITNESS_EXPIRED: 'The fitness certificate on this vehicle has expired.',
  VEHICLE_NOT_ACTIVE: 'This vehicle is not available for service.',
  VEHICLE_RETIRED: 'This vehicle has been retired.',
  NO_AVAILABLE_FUEL: 'This vehicle has no available fuel.',
};

/** Never exposes another driver's data, and never the licence NUMBER (BR-1504). */
const toSelfDriver = (driver) => ({
  id: driver.id,
  userId: driver.userId,
  employeeCode: driver.employeeCode,
  fullName: driver.fullName,
  employmentStatus: driver.employmentStatus,
  availability: driver.availability,
  /// The EXPIRY is shown so a driver can see it lapsing. The number is not.
  licenseExpiry: driver.licenseExpiry,
  phone: driver.user?.phone ?? null,
});

const toDriverVehicle = (vehicle) => ({
  id: vehicle.id,
  vehicleNumber: vehicle.vehicleNumber,
  registrationNumber: vehicle.registrationNumber,
  makeModel: vehicle.makeModel,
  tankCapacity: String(vehicle.tankCapacity),
  status: vehicle.status,
  calibrationExpiry: vehicle.calibrationExpiry,
  pesoLicenseExpiry: vehicle.pesoLicenseExpiry,
  inventory: vehicle.inventory
    ? {
        currentQuantity: String(vehicle.inventory.currentQuantity),
        heldQuantity: String(vehicle.inventory.heldQuantity),
        availableQuantity: String(
          Number(vehicle.inventory.currentQuantity) - Number(vehicle.inventory.heldQuantity)
        ),
        lastVerifiedAt: vehicle.inventory.lastVerifiedAt,
      }
    : null,
});

export const toSelfShift = (shift) => ({
  id: shift.id,
  vehicleId: shift.vehicleId,
  status: shift.status,
  startedAt: shift.startedAt,
  endedAt: shift.endedAt,
  openingTotalizer: shift.openingMeterReading
    ? String(shift.openingMeterReading.totalizer)
    : null,
  closingTotalizer: shift.closingMeterReading
    ? String(shift.closingMeterReading.totalizer)
    : null,
  openingFuelQuantity:
    shift.openingFuelQuantity === null || shift.openingFuelQuantity === undefined
      ? null
      : String(shift.openingFuelQuantity),
});

/**
 * Set availability: ONLINE, BREAK or OFFLINE.
 *
 * BR-310: a driver holding an active order may not go on a break or offline.
 * Releasing the order first is a deliberate act, and letting someone vanish
 * mid-delivery is how a customer ends up waiting for a tanker that is parked.
 *
 * ON_TRIP is NOT settable here. It is a consequence of holding an order, not a
 * state a driver chooses — the distinction lives on the order (docs/03 §3.1).
 */
export const setAvailability = async ({ userId, availability }) => {
  const driver = await resolveDriverProfile(userId);
  assertEmployable(driver);

  if (availability === DRIVER_AVAILABILITY.ON_TRIP) {
    throw new ConflictError('ON_TRIP is set by the platform, not by the driver', {
      code: ERROR_CODES.BAD_REQUEST,
    });
  }

  if (availability !== DRIVER_AVAILABILITY.ONLINE) {
    const active = await driverOrderRepository.countActiveOrdersForDriver(driver.id);

    if (active > 0) {
      throw new ConflictError(
        'You are holding an active order. Complete it or return it to dispatch first.',
        { code: ERROR_CODES.DRIVER_ALREADY_ASSIGNED, details: { activeOrders: active } }
      );
    }
  }

  const openShift = await driverRepository.findOpenShiftForDriver(driver.id);

  if (!openShift && availability !== DRIVER_AVAILABILITY.OFFLINE) {
    throw new ConflictError('Start a shift before going online', {
      code: ERROR_CODES.SHIFT_NOT_OPEN,
    });
  }

  const updated = await driverRepository.setAvailability({
    id: driver.id,
    availability,
  });

  log.info({ driverProfileId: driver.id, availability }, 'driver availability changed');

  return toSelfDriver({ ...updated, user: driver.user });
};
