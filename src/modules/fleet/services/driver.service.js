import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { DRIVER_EMPLOYMENT_STATUS, SHIFT_STATUS } from '../../../shared/constants/fleet.js';
import { PRINCIPALS } from '../../../shared/constants/rbac.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as userRepository from '../../identity/repositories/user.repository.js';
import * as driverRepository from '../repositories/driver.repository.js';
import * as inventoryRepository from '../repositories/inventory.repository.js';
import * as vehicleRepository from '../repositories/vehicle.repository.js';

import { assertVehicleUsableForShift } from './dispatchability.service.js';

const log = createLogger({ module: 'fleet.driver' });

/**
 * Driver employment profiles and shifts.
 *
 * Identity is NOT created here. A driver already exists as a `users` row with
 * principal DRIVER, created by an administrator through the identity module
 * (BR-301). This adds the employment record on top.
 *
 * Two orthogonal status axes (ADR-007):
 *   employmentStatus  admin-controlled, long-lived
 *   availability      driver-controlled, minute-by-minute
 */

const toPublicDriver = (driver, { includeLicenseNumber = false } = {}) => ({
  id: driver.id,
  userId: driver.userId,
  employeeCode: driver.employeeCode,
  fullName: driver.fullName,
  phone: driver.user?.phone ?? null,
  accountStatus: driver.user?.status ?? null,
  employmentStatus: driver.employmentStatus,
  availability: driver.availability,
  joinedOn: driver.joinedOn,
  license: {
    // BR-303: personal data. Included only in the single-driver detail read,
    // never in a list, so the number of paths that can leak it is minimal.
    ...(includeLicenseNumber ? { number: driver.licenseNumber } : {}),
    expiry: driver.licenseExpiry,
    documentKey: driver.licenseDocumentKey,
    /// Derived, so a client never has to compare dates itself and get it wrong.
    isExpired: isLicenceExpired(driver.licenseExpiry),
  },
  emergencyContact: {
    name: driver.emergencyContactName,
    phone: driver.emergencyContactPhone,
  },
  profileImageKey: driver.profileImageKey,
  notes: driver.notes,
  createdAt: driver.createdAt,
  updatedAt: driver.updatedAt,
});

/**
 * A licence lapses at the END of its expiry day, not at midnight the morning
 * of it. Off-by-one here would strand a driver who is still legally licensed.
 */
function isLicenceExpired(expiry, now = new Date()) {
  if (!expiry) return false;

  const endOfDay = new Date(expiry);
  endOfDay.setUTCHours(23, 59, 59, 999);

  return endOfDay < now;
}

export const listDrivers = async ({ employmentStatus, limit = 50, cursor }) => {
  const drivers = await driverRepository.list({ employmentStatus, limit: limit + 1, cursor });
  const hasMore = drivers.length > limit;
  const page = hasMore ? drivers.slice(0, limit) : drivers;

  return {
    drivers: page.map((driver) => toPublicDriver(driver)),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

export const getDriver = async (id) => {
  const driver = await driverRepository.findById(id);

  if (!driver) throw new NotFoundError('Driver not found');

  return toPublicDriver(driver, { includeLicenseNumber: true });
};

/**
 * Create the employment profile for an existing driver identity.
 *
 * The identity must already exist and must have principal DRIVER. Creating one
 * here would be a second way to mint an account, which is exactly what BR-301
 * and ADR-016 rule out.
 */
export const createDriverProfile = async ({ userId, actorUserId, ...input }) => {
  const user = await userRepository.findByIdWithRoles(userId);

  if (!user) {
    throw new NotFoundError('No user exists with that id', { code: ERROR_CODES.USER_NOT_FOUND });
  }

  if (user.principal !== PRINCIPALS.DRIVER) {
    throw new BadRequestError(
      'That account is not a driver identity. Create the driver account first.',
      { code: ERROR_CODES.WRONG_PRINCIPAL }
    );
  }

  const existing = await driverRepository.findByUserId(userId);

  if (existing) {
    throw new ConflictError('A driver profile already exists for that account', {
      code: ERROR_CODES.PROFILE_ALREADY_EXISTS,
    });
  }

  const driver = await driverRepository.create({
    data: {
      userId,
      employeeCode: input.employeeCode ?? null,
      fullName: input.fullName ?? null,
      licenseNumber: input.licenseNumber ?? null,
      licenseExpiry: input.licenseExpiry ?? null,
      licenseDocumentKey: input.licenseDocumentKey ?? null,
      profileImageKey: input.profileImageKey ?? null,
      emergencyContactName: input.emergencyContactName ?? null,
      emergencyContactPhone: input.emergencyContactPhone ?? null,
      joinedOn: input.joinedOn ?? null,
      notes: input.notes ?? null,
    },
    actorUserId,
  });

  log.info({ driverProfileId: driver.id, userId, actorUserId }, 'driver profile created');

  return toPublicDriver(driver, { includeLicenseNumber: true });
};

export const updateDriverProfile = async ({ id, actorUserId, ...input }) => {
  const existing = await driverRepository.findById(id);

  if (!existing) throw new NotFoundError('Driver not found');

  const data = {};

  for (const field of [
    'employeeCode',
    'fullName',
    'licenseNumber',
    'licenseExpiry',
    'licenseDocumentKey',
    'profileImageKey',
    'emergencyContactName',
    'emergencyContactPhone',
    'joinedOn',
    'employmentStatus',
    'notes',
  ]) {
    if (input[field] !== undefined) data[field] = input[field];
  }

  // BR-312: suspension takes effect immediately. The driver keeps their
  // history and their assignment record - an expired licence or a suspension
  // must never delete history - but they are taken off duty at once.
  if (
    data.employmentStatus &&
    data.employmentStatus !== DRIVER_EMPLOYMENT_STATUS.ACTIVE &&
    existing.employmentStatus === DRIVER_EMPLOYMENT_STATUS.ACTIVE
  ) {
    const openShift = await driverRepository.findOpenShiftForDriver(id);

    if (openShift) {
      throw new ConflictError(
        'This driver has an open shift. End the shift before changing their employment status.',
        { code: ERROR_CODES.DRIVER_HAS_OPEN_SHIFT }
      );
    }

    data.availability = 'OFFLINE';
  }

  const driver = await driverRepository.update({ id, data, actorUserId });

  log.info({ driverProfileId: id, actorUserId }, 'driver profile updated');

  return toPublicDriver(driver, { includeLicenseNumber: true });
};

// --- Shifts ----------------------------------------------------------------

const toPublicShift = (shift) => ({
  id: shift.id,
  status: shift.status,
  driver: shift.driverProfile,
  vehicle: shift.vehicle,
  startedAt: shift.startedAt,
  endedAt: shift.endedAt,
  openingMeterReading: shift.openingMeterReading
    ? { ...shift.openingMeterReading, totalizer: String(shift.openingMeterReading.totalizer) }
    : null,
  closingMeterReading: shift.closingMeterReading
    ? { ...shift.closingMeterReading, totalizer: String(shift.closingMeterReading.totalizer) }
    : null,
  openingFuelQuantity:
    shift.openingFuelQuantity === null ? null : String(shift.openingFuelQuantity),
  closingFuelQuantity:
    shift.closingFuelQuantity === null ? null : String(shift.closingFuelQuantity),
  /// Litres dispensed during the shift, derived from the two readings rather
  /// than from any typed quantity (BR-901).
  dispensedQuantity:
    shift.openingMeterReading && shift.closingMeterReading
      ? String(
          Number(shift.closingMeterReading.totalizer) - Number(shift.openingMeterReading.totalizer)
        )
      : null,
  lastKnownLocation:
    shift.lastLatitude === null
      ? null
      : {
          latitude: String(shift.lastLatitude),
          longitude: String(shift.lastLongitude),
          at: shift.lastLocationAt,
        },
  notes: shift.notes,
});

export const listShifts = async ({ status, driverProfileId, vehicleId, limit = 50, cursor }) => {
  const shifts = await driverRepository.listShifts({
    status,
    driverProfileId,
    vehicleId,
    limit: limit + 1,
    cursor,
  });

  const hasMore = shifts.length > limit;
  const page = hasMore ? shifts.slice(0, limit) : shifts;

  return {
    shifts: page.map(toPublicShift),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

/**
 * Start a shift.
 *
 * The gate that matters is BR-304: a driver whose licence has expired cannot
 * start a shift. Enforced HERE rather than at assignment, because this is the
 * moment they would actually drive - blocking assignment would stop rostering
 * a driver whose renewal is in progress.
 */
export const startShift = async ({
  driverProfileId,
  vehicleId,
  actorUserId,
  openingTotalizer,
  openingFuelQuantity,
  photoKey,
  notes,
}) => {
  const driver = await driverRepository.findById(driverProfileId);

  if (!driver) throw new NotFoundError('Driver not found');

  if (driver.employmentStatus !== DRIVER_EMPLOYMENT_STATUS.ACTIVE) {
    throw new ConflictError('Only an active driver can start a shift', {
      code: ERROR_CODES.DRIVER_NOT_ACTIVE,
    });
  }

  // BR-304 [BLOCKER].
  if (isLicenceExpired(driver.licenseExpiry)) {
    throw new ConflictError(
      "This driver's licence has expired. It must be renewed before they can drive.",
      {
        code: ERROR_CODES.DRIVER_LICENCE_EXPIRED,
        details: { licenseExpiry: driver.licenseExpiry },
      }
    );
  }

  // INV-07: at most one open shift per driver. A partial unique index backs
  // this up, so a double-submit cannot open two.
  const existingShift = await driverRepository.findOpenShiftForDriver(driverProfileId);

  if (existingShift) {
    throw new ConflictError('This driver already has an open shift', {
      code: ERROR_CODES.SHIFT_ALREADY_OPEN,
      details: { shiftId: existingShift.id },
    });
  }

  const vehicle = await vehicleRepository.findByIdBasic(vehicleId);

  if (!vehicle) throw new NotFoundError('Vehicle not found');

  // BR-402: calibration and PESO are legal requirements, not preferences.
  const { usable, blockers } = assertVehicleUsableForShift({ vehicle });

  if (!usable) {
    throw new ConflictError('This vehicle cannot be operated', {
      code: ERROR_CODES.VEHICLE_NOT_DISPATCHABLE,
      details: { blockers },
    });
  }

  const vehicleShift = await driverRepository.findOpenShiftForVehicle(vehicleId);

  if (vehicleShift) {
    throw new ConflictError('This vehicle already has an open shift', {
      code: ERROR_CODES.SHIFT_ALREADY_OPEN,
    });
  }

  // The driver must be assigned to the vehicle they are taking out, so the
  // assignment history explains who was responsible for it.
  const assignment = await vehicleRepository.findActiveAssignmentForVehicle(vehicleId);

  if (!assignment || assignment.driverProfileId !== driverProfileId) {
    throw new ConflictError('That driver is not assigned to this vehicle', {
      code: ERROR_CODES.DRIVER_NOT_ASSIGNED_TO_VEHICLE,
    });
  }

  // Opening totaliser must not regress (BR-903).
  const latest = await driverRepository.findLatestReading(vehicleId);

  if (latest && Number(openingTotalizer) < Number(latest.totalizer)) {
    throw new BadRequestError(
      `Opening reading ${openingTotalizer} is below the last recorded reading ${latest.totalizer}.`,
      { code: ERROR_CODES.METER_READING_REGRESSION }
    );
  }

  const inventory = await inventoryRepository.findInventory(vehicleId);

  const shift = await driverRepository.openShift({
    driverProfileId,
    driverUserId: driver.userId,
    vehicleId,
    openingTotalizer,
    // Falls back to the recorded stock, so a shift always has a fuel baseline
    // even if the driver did not dip the tank.
    openingFuelQuantity: openingFuelQuantity ?? inventory?.currentQuantity ?? null,
    photoKey,
    notes,
    actorUserId,
  });

  log.info({ shiftId: shift.id, driverProfileId, vehicleId, actorUserId }, 'shift started');

  return toPublicShift(shift);
};

/**
 * End a shift.
 *
 * BR-307 requires refusing to close a shift while the driver has an active
 * order. Orders do not exist yet, so that check cannot be written - it is
 * recorded as debt rather than silently omitted, because forgetting it later
 * means a driver can go off duty mid-delivery.
 */
export const endShift = async ({
  shiftId,
  actorUserId,
  closingTotalizer,
  closingFuelQuantity,
  photoKey,
  notes,
}) => {
  const shift = await driverRepository.findShiftById(shiftId);

  if (!shift) throw new NotFoundError('Shift not found');

  if (shift.status !== SHIFT_STATUS.OPEN) {
    throw new ConflictError('This shift has already ended', {
      code: ERROR_CODES.SHIFT_NOT_OPEN,
    });
  }

  // BR-903: closing cannot be below opening. Real causes are a meter reset or
  // a transposed digit, both of which need a human.
  const openingTotalizer = shift.openingMeterReading?.totalizer;

  if (openingTotalizer !== undefined && Number(closingTotalizer) < Number(openingTotalizer)) {
    throw new BadRequestError(
      `Closing reading ${closingTotalizer} is below the opening reading ${openingTotalizer}. ` +
        'Check for a meter reset or a transposed digit.',
      {
        code: ERROR_CODES.METER_READING_REGRESSION,
        details: { opening: String(openingTotalizer), closing: String(closingTotalizer) },
      }
    );
  }

  const closed = await driverRepository.closeShift({
    shiftId,
    driverProfileId: shift.driverProfileId,
    vehicleId: shift.vehicleId,
    closingTotalizer,
    closingFuelQuantity: closingFuelQuantity ?? null,
    photoKey,
    notes,
    actorUserId,
  });

  log.info(
    {
      shiftId,
      actorUserId,
      dispensed: Number(closingTotalizer) - Number(openingTotalizer ?? closingTotalizer),
    },
    'shift ended'
  );

  return toPublicShift(closed);
};
