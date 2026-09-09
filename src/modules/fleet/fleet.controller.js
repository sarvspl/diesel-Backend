import { sendCreated, sendSuccess } from '../../shared/utils/api-response.js';

import * as assignmentService from './services/assignment.service.js';
import * as driverService from './services/driver.service.js';
import * as inventoryService from './services/inventory.service.js';
import * as vehicleService from './services/vehicle.service.js';

/**
 * Thin HTTP layer for fleet administration.
 *
 * The acting administrator always comes from `req.auth`, never the body -
 * every inventory movement and assignment records who did it, and a
 * self-declared actor is not an audit trail.
 */

// --- Drivers ---------------------------------------------------------------

/** GET /api/v1/admin/drivers */
export const listDrivers = async (req, res) => {
  const result = await driverService.listDrivers(req.validated.query);

  return sendSuccess(res, { message: 'Drivers retrieved', data: result });
};

/**
 * POST /api/v1/admin/drivers
 *
 * Onboarding: creates the login identity and the employment record together.
 * `/drivers/profile` below is the narrower path for an identity that already
 * exists.
 */
export const onboardDriver = async (req, res) => {
  const driver = await driverService.onboardDriver({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Driver onboarded', data: { driver } });
};

/** POST /api/v1/admin/drivers/profile */
export const createDriverProfile = async (req, res) => {
  const driver = await driverService.createDriverProfile({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Driver profile created', data: { driver } });
};

/** PATCH /api/v1/admin/drivers/:id */
export const updateDriverProfile = async (req, res) => {
  const driver = await driverService.updateDriverProfile({
    id: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Driver profile updated', data: { driver } });
};

// --- Vehicles --------------------------------------------------------------

/** GET /api/v1/admin/vehicles */
export const listVehicles = async (req, res) => {
  const result = await vehicleService.listVehicles(req.validated.query);

  return sendSuccess(res, { message: 'Vehicles retrieved', data: result });
};

/** POST /api/v1/admin/vehicles */
export const createVehicle = async (req, res) => {
  const vehicle = await vehicleService.createVehicle({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Vehicle created', data: { vehicle } });
};

/** PATCH /api/v1/admin/vehicles/:id */
export const updateVehicle = async (req, res) => {
  const vehicle = await vehicleService.updateVehicle({
    id: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Vehicle updated', data: { vehicle } });
};

/** GET /api/v1/admin/vehicles/:id */
export const getVehicle = async (req, res) => {
  const vehicle = await vehicleService.getVehicle(req.validated.params.id);

  return sendSuccess(res, { message: 'Vehicle retrieved', data: { vehicle } });
};

/** GET /api/v1/admin/vehicles/:id/telemetry — live IoT device reading. */
export const getVehicleTelemetry = async (req, res) => {
  const telemetry = await vehicleService.getVehicleTelemetry(req.validated.params.id);

  return sendSuccess(res, { message: 'Vehicle telemetry retrieved', data: { telemetry } });
};

// --- Assignment ------------------------------------------------------------

/** POST /api/v1/admin/vehicles/:id/assign-driver */
export const assignDriver = async (req, res) => {
  const assignment = await assignmentService.assignDriver({
    vehicleId: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Driver assigned', data: { assignment } });
};

/** POST /api/v1/admin/vehicles/:id/unassign-driver */
export const unassignDriver = async (req, res) => {
  const assignment = await assignmentService.unassignDriver({
    vehicleId: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Driver unassigned', data: { assignment } });
};

/** GET /api/v1/admin/vehicles/:id/history */
export const getAssignmentHistory = async (req, res) => {
  const result = await assignmentService.getAssignmentHistory({
    vehicleId: req.validated.params.id,
    ...req.validated.query,
  });

  return sendSuccess(res, { message: 'Assignment history retrieved', data: result });
};

// --- Inventory -------------------------------------------------------------

/** POST /api/v1/admin/vehicles/:id/refill */
export const recordRefill = async (req, res) => {
  const adjustment = await inventoryService.recordRefill({
    vehicleId: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Refill recorded', data: { adjustment } });
};

/** POST /api/v1/admin/vehicles/:id/manual-adjustment */
/**
 * POST /api/v1/admin/vehicles/:id/dip-reading
 *
 * 200, not 201: the dip may create nothing at all. When it agrees with the
 * recorded level there is no adjustment to point at, and claiming a resource
 * was created would be a lie about what happened.
 */
export const recordDipReading = async (req, res) => {
  const result = await inventoryService.recordDipReading({
    vehicleId: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, {
    message: result.adjustment
      ? 'Dip reading recorded — a variance was posted'
      : 'Dip reading confirmed the recorded level',
    data: result,
  });
};

export const recordManualAdjustment = async (req, res) => {
  const adjustment = await inventoryService.recordManualAdjustment({
    vehicleId: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Adjustment recorded', data: { adjustment } });
};

/** POST /api/v1/admin/vehicles/:id/meter-reading */
export const recordMeterReading = async (req, res) => {
  const reading = await inventoryService.recordMeterReading({
    vehicleId: req.validated.params.id,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Meter reading recorded', data: { reading } });
};

// --- Shifts ----------------------------------------------------------------

/** GET /api/v1/admin/shifts */
export const listShifts = async (req, res) => {
  const result = await driverService.listShifts(req.validated.query);

  return sendSuccess(res, { message: 'Shifts retrieved', data: result });
};

/** POST /api/v1/admin/shifts/start */
export const startShift = async (req, res) => {
  const shift = await driverService.startShift({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Shift started', data: { shift } });
};

/** POST /api/v1/admin/shifts/end */
export const endShift = async (req, res) => {
  const shift = await driverService.endShift({
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Shift ended', data: { shift } });
};
