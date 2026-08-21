import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { VEHICLE_STATUS } from '../../../shared/constants/fleet.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as driverRepository from '../repositories/driver.repository.js';
import * as vehicleRepository from '../repositories/vehicle.repository.js';

import { assessDispatchability } from './dispatchability.service.js';

const log = createLogger({ module: 'fleet.vehicle' });

/**
 * Vehicle administration.
 *
 * Fleet owns what a vehicle IS and whether it is capable. It does not decide
 * which vehicle serves which order - that is Dispatch (docs/06 §6).
 */

const toPublicVehicle = (vehicle) => {
  const activeAssignment = vehicle.assignments?.[0] ?? null;

  const dispatchability = assessDispatchability({
    vehicle,
    inventory: vehicle.inventory,
    hasActiveDriver: Boolean(activeAssignment),
  });

  return {
    id: vehicle.id,
    vehicleNumber: vehicle.vehicleNumber,
    registrationNumber: vehicle.registrationNumber,
    makeModel: vehicle.makeModel,
    // Litres as strings: a JSON number is a double in every client, and stock
    // arithmetic on a rounded figure is how tankers end up "empty" with fuel
    // in them (docs/10 §5.3).
    tankCapacity: String(vehicle.tankCapacity),
    compartmentCount: vehicle.compartmentCount,
    flowMeterEnabled: vehicle.flowMeterEnabled ?? false,
    status: vehicle.status,
    compliance: {
      pesoLicenseNumber: vehicle.pesoLicenseNumber,
      pesoLicenseExpiry: vehicle.pesoLicenseExpiry,
      calibrationCertNumber: vehicle.calibrationCertNumber,
      calibrationExpiry: vehicle.calibrationExpiry,
      insuranceExpiry: vehicle.insuranceExpiry,
      pucExpiry: vehicle.pucExpiry,
      fitnessExpiry: vehicle.fitnessExpiry,
    },
    inventory: vehicle.inventory
      ? {
          currentQuantity: String(vehicle.inventory.currentQuantity),
          heldQuantity: String(vehicle.inventory.heldQuantity),
          availableQuantity: String(
            Number(vehicle.inventory.currentQuantity) - Number(vehicle.inventory.heldQuantity)
          ),
          lastSource: vehicle.inventory.lastSource,
          lastVerifiedAt: vehicle.inventory.lastVerifiedAt,
          staleAfter: vehicle.inventory.staleAfter,
        }
      : null,
    currentAssignment: activeAssignment
      ? {
          id: activeAssignment.id,
          assignedAt: activeAssignment.assignedAt,
          driver: activeAssignment.driverProfile,
        }
      : null,
    /// Computed, never stored. Dispatch calls the same function.
    dispatchability,
    retiredAt: vehicle.retiredAt,
    retiredReason: vehicle.retiredReason,
    notes: vehicle.notes,
    createdAt: vehicle.createdAt,
    updatedAt: vehicle.updatedAt,
  };
};

export const listVehicles = async ({ status, includeRetired = false, limit = 50, cursor }) => {
  const vehicles = await vehicleRepository.list({
    status,
    includeRetired,
    limit: limit + 1,
    cursor,
  });

  const hasMore = vehicles.length > limit;
  const page = hasMore ? vehicles.slice(0, limit) : vehicles;

  return {
    vehicles: page.map(toPublicVehicle),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

export const getVehicle = async (id) => {
  const vehicle = await vehicleRepository.findById(id);

  if (!vehicle) throw new NotFoundError('Vehicle not found');

  return toPublicVehicle(vehicle);
};

export const createVehicle = async ({ actorUserId, openingFuelQuantity = '0', ...input }) => {
  if (Number(openingFuelQuantity) > Number(input.tankCapacity)) {
    throw new BadRequestError('Opening fuel quantity exceeds the tank capacity', {
      code: ERROR_CODES.EXCEEDS_CAPACITY,
    });
  }

  const vehicle = await vehicleRepository.create({
    data: input,
    openingQuantity: openingFuelQuantity,
    actorUserId,
  });

  log.info({ vehicleId: vehicle.id, actorUserId }, 'vehicle created');

  return toPublicVehicle({ ...vehicle, assignments: [] });
};

/**
 * Patch a vehicle.
 *
 * Retiring is handled here rather than through a DELETE: it is a status
 * change with a reason, not a removal, and the row survives because
 * deliveries reference it forever.
 */
export const updateVehicle = async ({ id, actorUserId, ...input }) => {
  const existing = await vehicleRepository.findById(id);

  if (!existing) throw new NotFoundError('Vehicle not found');

  if (existing.status === VEHICLE_STATUS.RETIRED && input.status !== undefined) {
    throw new ConflictError('A retired vehicle cannot be returned to service', {
      code: ERROR_CODES.VEHICLE_RETIRED,
    });
  }

  const data = {};

  for (const field of [
    'vehicleNumber',
    'registrationNumber',
    'makeModel',
    'tankCapacity',
    'compartmentCount',
    'pesoLicenseNumber',
    'pesoLicenseExpiry',
    'calibrationCertNumber',
    'calibrationExpiry',
    'insuranceExpiry',
    'pucExpiry',
    'fitnessExpiry',
    'status',
    'notes',
  ]) {
    if (input[field] !== undefined) data[field] = input[field];
  }

  // Reducing capacity below what is already in the tank would make the
  // inventory invariant false the moment it is saved.
  if (data.tankCapacity !== undefined && existing.inventory) {
    if (Number(data.tankCapacity) < Number(existing.inventory.currentQuantity)) {
      throw new BadRequestError(
        'Tank capacity cannot be less than the fuel currently recorded in the vehicle',
        { code: ERROR_CODES.EXCEEDS_CAPACITY }
      );
    }
  }

  if (input.status === VEHICLE_STATUS.RETIRED) {
    const openShift = await driverRepository.findOpenShiftForVehicle(id);

    if (openShift) {
      throw new ConflictError('This vehicle has an open shift. End the shift before retiring it.', {
        code: ERROR_CODES.VEHICLE_HAS_OPEN_SHIFT,
      });
    }

    data.retiredAt = new Date();
    data.retiredReason = input.retiredReason ?? null;
  }

  const vehicle = await vehicleRepository.update({ id, data, actorUserId });

  log.info({ vehicleId: id, actorUserId, status: vehicle.status }, 'vehicle updated');

  return toPublicVehicle(vehicle);
};

export { toPublicVehicle };
