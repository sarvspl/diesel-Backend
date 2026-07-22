import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { DRIVER_EMPLOYMENT_STATUS, VEHICLE_STATUS } from '../../../shared/constants/fleet.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as driverRepository from '../repositories/driver.repository.js';
import * as vehicleRepository from '../repositories/vehicle.repository.js';

const log = createLogger({ module: 'fleet.assignment' });

/**
 * Driver-to-vehicle assignment.
 *
 * TWO exclusivity rules, both enforced twice:
 *   one active assignment per VEHICLE
 *   one active vehicle per DRIVER
 *
 * Checked here for a useful error message, and by partial unique indexes on
 * `released_at IS NULL` so that two concurrent assignments cannot both win.
 * The service check alone would be a read-then-write race (docs/08 §9).
 *
 * History is append-only: unassigning sets `releasedAt`, never deletes.
 */

export const assignDriver = async ({ vehicleId, driverProfileId, actorUserId }) => {
  const vehicle = await vehicleRepository.findByIdBasic(vehicleId);

  if (!vehicle) throw new NotFoundError('Vehicle not found');

  if (vehicle.status === VEHICLE_STATUS.RETIRED) {
    throw new ConflictError('A retired vehicle cannot be assigned a driver', {
      code: ERROR_CODES.VEHICLE_RETIRED,
    });
  }

  const driver = await driverRepository.findById(driverProfileId);

  if (!driver) throw new NotFoundError('Driver not found');

  // A suspended driver must not be given a vehicle (BR-312). An expired
  // licence is deliberately NOT checked here: assignment is an administrative
  // act, and blocking it would prevent rostering a driver whose renewal is in
  // progress. The licence is checked when a shift STARTS (BR-304), which is
  // the moment they would actually drive.
  if (driver.employmentStatus !== DRIVER_EMPLOYMENT_STATUS.ACTIVE) {
    throw new ConflictError('Only an active driver can be assigned a vehicle', {
      code: ERROR_CODES.DRIVER_NOT_ACTIVE,
    });
  }

  const vehicleAssignment = await vehicleRepository.findActiveAssignmentForVehicle(vehicleId);

  if (vehicleAssignment) {
    if (vehicleAssignment.driverProfileId === driverProfileId) {
      // Already the intended state. Not an error to retry.
      throw new ConflictError('That driver is already assigned to this vehicle', {
        code: ERROR_CODES.ASSIGNMENT_UNCHANGED,
      });
    }

    throw new ConflictError('This vehicle already has an assigned driver. Unassign them first.', {
      code: ERROR_CODES.VEHICLE_ALREADY_ASSIGNED,
    });
  }

  const driverAssignment = await vehicleRepository.findActiveAssignmentForDriver(driverProfileId);

  if (driverAssignment) {
    throw new ConflictError('That driver is already assigned to another vehicle', {
      code: ERROR_CODES.DRIVER_ALREADY_ASSIGNED,
    });
  }

  const assignment = await vehicleRepository.createAssignment({
    vehicleId,
    driverProfileId,
    actorUserId,
  });

  log.info({ vehicleId, driverProfileId, actorUserId }, 'driver assigned to vehicle');

  return assignment;
};

/**
 * Release the current assignment.
 *
 * Refused while a shift is open: the driver is physically out in that vehicle,
 * and unassigning would leave an open shift referencing a vehicle nobody is
 * responsible for. End the shift first (the same reasoning as BR-307).
 */
export const unassignDriver = async ({ vehicleId, actorUserId, reason }) => {
  const vehicle = await vehicleRepository.findByIdBasic(vehicleId);

  if (!vehicle) throw new NotFoundError('Vehicle not found');

  const assignment = await vehicleRepository.findActiveAssignmentForVehicle(vehicleId);

  if (!assignment) {
    throw new ConflictError('This vehicle has no assigned driver', {
      code: ERROR_CODES.VEHICLE_NOT_ASSIGNED,
    });
  }

  const openShift = await driverRepository.findOpenShiftForVehicle(vehicleId);

  if (openShift) {
    throw new ConflictError('This vehicle has an open shift. End the shift before unassigning.', {
      code: ERROR_CODES.VEHICLE_HAS_OPEN_SHIFT,
    });
  }

  const released = await vehicleRepository.releaseAssignment({
    id: assignment.id,
    actorUserId,
    reason,
  });

  log.info({ vehicleId, assignmentId: assignment.id, actorUserId }, 'driver unassigned');

  return released;
};

export const getAssignmentHistory = async ({ vehicleId, limit = 50, cursor }) => {
  const vehicle = await vehicleRepository.findByIdBasic(vehicleId);

  if (!vehicle) throw new NotFoundError('Vehicle not found');

  const rows = await vehicleRepository.listAssignmentHistory({
    vehicleId,
    limit: limit + 1,
    cursor,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    assignments: page.map((row) => ({
      id: row.id,
      assignedAt: row.assignedAt,
      releasedAt: row.releasedAt,
      releaseReason: row.releaseReason,
      isActive: row.releasedAt === null,
      assignedByUserId: row.assignedByUserId,
      releasedByUserId: row.releasedByUserId,
      driver: row.driverProfile,
    })),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};
