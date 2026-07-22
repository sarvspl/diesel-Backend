import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { DRIVER_AVAILABILITY } from '../../../shared/constants/fleet.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as driverRepository from '../../fleet/repositories/driver.repository.js';
import * as fleetDriverService from '../../fleet/services/driver.service.js';
import * as driverOrderRepository from '../repositories/driver-order.repository.js';

import { resolveDriverProfile, toSelfShift } from './driver-self.service.js';

const log = createLogger({ module: 'driver.shift' });

/**
 * Shift management, from the driver's own device.
 *
 * A THIN WRAPPER over Fleet's shift service, and deliberately so. Fleet already
 * enforces BR-304 (expired licence), BR-402 (calibration and PESO), INV-07 (one
 * open shift) and the opening-reading regression check. Reimplementing any of
 * that here would create a second copy of a legal rule, and the copy that
 * drifts is the one that lets an uncalibrated tanker onto the road.
 *
 * What this layer adds is the two things Fleet cannot know:
 *   - the driver is resolved from the TOKEN, never a parameter (BR-225)
 *   - BR-307, which Fleet recorded as debt because orders did not exist yet
 */

export const getCurrentShift = async (userId) => {
  const driver = await resolveDriverProfile(userId);
  const shift = await driverRepository.findOpenShiftForDriver(driver.id);

  return shift ? toSelfShift(shift) : null;
};

/**
 * BR-906, enforced BEFORE the write.
 *
 * The database has a `meter_readings_manual_requires_photo` check constraint,
 * so a missing photo is caught either way — but it surfaces as a 500, and a
 * driver standing at a tanker cannot act on "internal server error". Checking
 * here turns it into a 400 the app can respond to by reopening the camera.
 */
const assertMeterPhoto = (photoKey) => {
  if (!photoKey) {
    throw new BadRequestError('A photograph of the meter is required', {
      code: ERROR_CODES.METER_PHOTO_REQUIRED,
    });
  }
};

export const startShift = async ({ userId, vehicleId, photoKey, ...input }) => {
  const driver = await resolveDriverProfile(userId);

  assertMeterPhoto(photoKey);

  const shift = await fleetDriverService.startShift({
    driverProfileId: driver.id,
    vehicleId,
    actorUserId: userId,
    photoKey,
    ...input,
  });

  // A shift that starts with the driver still OFFLINE would leave them
  // invisible to dispatch while sitting in a running tanker.
  await driverRepository.setAvailability({
    id: driver.id,
    availability: DRIVER_AVAILABILITY.ONLINE,
  });

  log.info({ driverProfileId: driver.id, vehicleId }, 'shift started by driver');

  return shift;
};

/**
 * End a shift.
 *
 * BR-307: a shift cannot close while the driver holds an active order. Fleet
 * left this as documented debt — "forgetting it later means a driver can go off
 * duty mid-delivery" — and orders now exist, so it is enforced here at the only
 * place a driver can close their own shift.
 */
export const endShift = async ({ userId, declaredCash, photoKey, ...input }) => {
  const driver = await resolveDriverProfile(userId);

  assertMeterPhoto(photoKey);

  const shift = await driverRepository.findOpenShiftForDriver(driver.id);

  if (!shift) {
    throw new NotFoundError('You have no open shift', { code: ERROR_CODES.SHIFT_NOT_OPEN });
  }

  const activeOrders = await driverOrderRepository.countActiveOrdersForDriver(driver.id);

  if (activeOrders > 0) {
    throw new ConflictError(
      'You are still holding an active order. Complete it, fail it, or return it to dispatch before ending your shift.',
      {
        code: ERROR_CODES.SHIFT_HAS_ACTIVE_ORDER,
        details: { activeOrders },
      }
    );
  }

  const closed = await fleetDriverService.endShift({
    shiftId: shift.id,
    actorUserId: userId,
    photoKey,
    ...input,
    /**
     * Declared cash is appended to the shift note rather than stored in its own
     * column. Driver cash is a real ledger balance (BR-1020) owned by a
     * payments module that does not exist; inventing a column here would create
     * a second place cash lives, and reconciliation would then have two answers.
     */
    notes: declaredCash
      ? `${input.notes ? `${input.notes} · ` : ''}Declared cash: ${declaredCash}`
      : input.notes,
  });

  await driverRepository.setAvailability({
    id: driver.id,
    availability: DRIVER_AVAILABILITY.OFFLINE,
  });

  log.info({ driverProfileId: driver.id, shiftId: shift.id }, 'shift ended by driver');

  return closed;
};
