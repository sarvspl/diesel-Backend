import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';

import * as controller from './fleet.controller.js';
import {
  assignDriverSchema,
  assignmentHistorySchema,
  createDriverProfileSchema,
  createVehicleSchema,
  endShiftSchema,
  listDriversSchema,
  listShiftsSchema,
  listVehiclesSchema,
  manualAdjustmentSchema,
  meterReadingSchema,
  refillSchema,
  startShiftSchema,
  unassignDriverSchema,
  updateDriverProfileSchema,
  updateVehicleSchema,
  vehicleIdSchema,
} from './fleet.schema.js';

/**
 * Fleet administration.
 *
 * ADMIN principal on every route, plus a per-route permission. The principal
 * check is not redundant with the permission: it stops a customer or driver
 * token from ever reaching an admin route even if a permission were mis-granted
 * during a role edit.
 *
 * Note the deliberate split between `inventory.record` and `inventory.adjust`.
 * Recording a refill is routine operations work. Correcting stock by hand can
 * conceal theft, so it is a separate and higher grant - the same
 * separation-of-duties reasoning as refund create versus approve (docs/03 §4.4).
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.ADMIN));

// --- Drivers ---------------------------------------------------------------

router.get(
  '/drivers',
  requirePermission(PERMISSIONS.DRIVER_READ),
  validate(listDriversSchema),
  controller.listDrivers
);

router.post(
  '/drivers/profile',
  requirePermission(PERMISSIONS.DRIVER_MANAGE),
  validate(createDriverProfileSchema),
  controller.createDriverProfile
);

router.patch(
  '/drivers/:id',
  requirePermission(PERMISSIONS.DRIVER_MANAGE),
  validate(updateDriverProfileSchema),
  controller.updateDriverProfile
);

// --- Shifts ----------------------------------------------------------------
// Registered BEFORE the parameterised vehicle routes so `/shifts/start` can
// never be captured by a `/:id` pattern on another router mounted at the same
// prefix.

router.get(
  '/shifts',
  requirePermission(PERMISSIONS.SHIFT_READ),
  validate(listShiftsSchema),
  controller.listShifts
);

router.post(
  '/shifts/start',
  requirePermission(PERMISSIONS.SHIFT_MANAGE),
  validate(startShiftSchema),
  controller.startShift
);

router.post(
  '/shifts/end',
  requirePermission(PERMISSIONS.SHIFT_MANAGE),
  validate(endShiftSchema),
  controller.endShift
);

// --- Vehicles --------------------------------------------------------------

router.get(
  '/vehicles',
  requirePermission(PERMISSIONS.VEHICLE_READ),
  validate(listVehiclesSchema),
  controller.listVehicles
);

router.post(
  '/vehicles',
  requirePermission(PERMISSIONS.VEHICLE_MANAGE),
  validate(createVehicleSchema),
  controller.createVehicle
);

router.get(
  '/vehicles/:id',
  requirePermission(PERMISSIONS.VEHICLE_READ),
  validate(vehicleIdSchema),
  controller.getVehicle
);

router.patch(
  '/vehicles/:id',
  requirePermission(PERMISSIONS.VEHICLE_MANAGE),
  validate(updateVehicleSchema),
  controller.updateVehicle
);

router.get(
  '/vehicles/:id/history',
  requirePermission(PERMISSIONS.VEHICLE_READ),
  validate(assignmentHistorySchema),
  controller.getAssignmentHistory
);

router.post(
  '/vehicles/:id/assign-driver',
  requirePermission(PERMISSIONS.VEHICLE_ASSIGN),
  validate(assignDriverSchema),
  controller.assignDriver
);

router.post(
  '/vehicles/:id/unassign-driver',
  requirePermission(PERMISSIONS.VEHICLE_ASSIGN),
  validate(unassignDriverSchema),
  controller.unassignDriver
);

// --- Inventory -------------------------------------------------------------

router.post(
  '/vehicles/:id/refill',
  requirePermission(PERMISSIONS.INVENTORY_RECORD),
  validate(refillSchema),
  controller.recordRefill
);

/** Higher grant: a manual correction can conceal a loss. */
router.post(
  '/vehicles/:id/manual-adjustment',
  requirePermission(PERMISSIONS.INVENTORY_ADJUST),
  validate(manualAdjustmentSchema),
  controller.recordManualAdjustment
);

router.post(
  '/vehicles/:id/meter-reading',
  requirePermission(PERMISSIONS.INVENTORY_RECORD),
  validate(meterReadingSchema),
  controller.recordMeterReading
);

export default router;
