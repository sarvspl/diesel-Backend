import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';

import * as controller from './driver.controller.js';
import {
  arriveSchema,
  availabilitySchema,
  completeDeliverySchema,
  endShiftSchema,
  listOrdersSchema,
  locationSchema,
  nearbyRequestsSchema,
  orderIdSchema,
  rejectOrderSchema,
  routeSchema,
  startDispensingSchema,
  startShiftSchema,
  updateSelfSchema,
} from './driver.schema.js';

/**
 * The driver app's API surface.
 *
 * DRIVER principal on every route, plus a per-route permission. The principal
 * check is not redundant: it stops a customer or admin token reaching these
 * even if a permission were mis-granted during a role edit — the same defence
 * every other module applies.
 *
 * NOTHING HERE TAKES A DRIVER IDENTIFIER. The driver is resolved from the
 * token on every request, which makes cross-driver access impossible rather
 * than merely forbidden (BR-225). A driver cannot ask about another driver's
 * shift, orders or vehicle because there is no parameter in which to name one.
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.DRIVER));

// --- Identity and availability ---------------------------------------------

/** Everything the app needs on launch: profile, vehicle, shift, blockers. */
router.get('/me', requirePermission(PERMISSIONS.DRIVER_READ_SELF), controller.getMe);

router.patch(
  '/me',
  requirePermission(PERMISSIONS.SHIFT_MANAGE_SELF),
  validate(updateSelfSchema),
  controller.updateMe
);

router.patch(
  '/availability',
  requirePermission(PERMISSIONS.SHIFT_MANAGE_SELF),
  validate(availabilitySchema),
  controller.setAvailability
);

// --- Shifts ----------------------------------------------------------------
// Literal paths before any parameterised sibling.

router.get(
  '/shifts/current',
  requirePermission(PERMISSIONS.SHIFT_MANAGE_SELF),
  controller.getCurrentShift
);

router.post(
  '/shifts/start',
  requirePermission(PERMISSIONS.SHIFT_MANAGE_SELF),
  validate(startShiftSchema),
  controller.startShift
);

router.post(
  '/shifts/end',
  requirePermission(PERMISSIONS.SHIFT_MANAGE_SELF),
  validate(endShiftSchema),
  controller.endShift
);

// --- Location and maps ---------------------------------------------------
// The app reports the phone's position while a trip screen is open; the
// customer's tracking map reads it.

router.post(
  '/location',
  requirePermission(PERMISSIONS.DELIVERY_EXECUTE),
  validate(locationSchema),
  controller.updateLocation
);

router.get(
  '/orders/:id/route',
  requirePermission(PERMISSIONS.ORDER_READ_ASSIGNED),
  validate(routeSchema),
  controller.getRouteToOrder
);

// --- Nearby requests (self-dispatch) -------------------------------------
// Open orders near the driver's phone; the first driver to accept gets it.

router.get(
  '/requests',
  requirePermission(PERMISSIONS.ORDER_READ_ASSIGNED),
  validate(nearbyRequestsSchema),
  controller.listNearbyRequests
);

router.post(
  '/orders/:id/reject',
  requirePermission(PERMISSIONS.DELIVERY_EXECUTE),
  validate(rejectOrderSchema),
  controller.rejectOrder
);

router.post(
  '/requests/:id/accept',
  requirePermission(PERMISSIONS.DELIVERY_EXECUTE),
  validate(orderIdSchema),
  controller.acceptRequest
);

// --- Orders ----------------------------------------------------------------

router.get(
  '/orders',
  requirePermission(PERMISSIONS.ORDER_READ_ASSIGNED),
  validate(listOrdersSchema),
  controller.listOrders
);

router.get(
  '/orders/:id',
  requirePermission(PERMISSIONS.ORDER_READ_ASSIGNED),
  validate(orderIdSchema),
  controller.getOrder
);

// --- The delivery chain ----------------------------------------------------
// Each step is its own endpoint rather than one "set status" call, so the
// evidence each step requires is enforced by its own schema. A single
// status-setter would let a driver skip from ARRIVED to DELIVERED without ever
// producing a meter reading.

router.post(
  '/orders/:id/start-trip',
  requirePermission(PERMISSIONS.DELIVERY_EXECUTE),
  validate(orderIdSchema),
  controller.startTrip
);

router.post(
  '/orders/:id/arrive',
  requirePermission(PERMISSIONS.DELIVERY_EXECUTE),
  validate(arriveSchema),
  controller.arrive
);

/** Receiver verification and the opening totaliser, together. */
router.post(
  '/orders/:id/start-dispensing',
  requirePermission(PERMISSIONS.DELIVERY_SUBMIT),
  validate(startDispensingSchema),
  controller.startDispensing
);

/**
 * Unlock the tanker pump via the IoT dispense controller; returns the MPIN.
 * One authorization per order: a repeat returns the stored MPIN.
 */
router.post(
  '/orders/:id/iot-authorize',
  requirePermission(PERMISSIONS.DELIVERY_EXECUTE),
  validate(orderIdSchema),
  controller.iotAuthorize
);

/**
 * The closing reading and the outcome.
 *
 * Idempotent on the client-generated `clientDeliveryId` (BR-914): a driver in a
 * basement submits once, the request may be retried many times, and the fuel
 * must be recorded exactly once.
 */
router.post(
  '/orders/:id/complete',
  requirePermission(PERMISSIONS.DELIVERY_SUBMIT),
  validate(completeDeliverySchema),
  controller.completeDelivery
);

export default router;
