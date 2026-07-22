import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';

import * as controller from './order.controller.js';
import {
  cancelOrderSchema,
  listAllOrdersSchema,
  orderIdSchema,
  releaseSchema,
  reserveSchema,
  transitionOrderSchema,
} from './order.schema.js';

/**
 * Order administration.
 *
 * ADMIN principal plus a per-route permission. The split between them follows
 * docs/03 §4.4, which gives order READ to every operational role but reserves
 * cancel and adjust for SUPER_ADMIN, ADMIN and OPERATIONS_MANAGER - a
 * dispatcher may assign, and explicitly may not cancel.
 *
 * `order.reserve` is separate from `order.adjust` on purpose: moving an order's
 * status and moving a claim on a tanker's stock are different kinds of harm,
 * and the person who should be able to do one is not automatically the person
 * who should be able to do the other.
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.ADMIN));

router.get(
  '/',
  requirePermission(PERMISSIONS.ORDER_READ_ALL),
  validate(listAllOrdersSchema),
  controller.listAllOrders
);

/// The support investigation view: order, full timeline including SYSTEM
/// entries, reservations, and what may legally happen next (docs/04 §26).
router.get(
  '/:id',
  requirePermission(PERMISSIONS.ORDER_READ_ALL),
  validate(orderIdSchema),
  controller.getOrderForAdmin
);

router.get(
  '/:id/history',
  requirePermission(PERMISSIONS.ORDER_READ_ALL),
  validate(orderIdSchema),
  controller.getAdminOrderHistory
);

/**
 * Drive a legal transition by hand.
 *
 * NOT a status setter. It goes through the same single transition function as
 * every other status change, so the transition table, the actor rules, the side
 * effects and the timeline all apply. An operator cannot reach an illegal state
 * through this endpoint - there is no code path that would let them.
 */
router.post(
  '/:id/transition',
  requirePermission(PERMISSIONS.ORDER_ADJUST),
  validate(transitionOrderSchema),
  controller.transition
);

/// Separate from /transition: cancellation needs `order.cancel`, records who
/// cancelled and why, and releases the reservation (BR-1203, BR-1206).
router.post(
  '/:id/cancel',
  requirePermission(PERMISSIONS.ORDER_CANCEL),
  validate(cancelOrderSchema),
  controller.cancelOrderAsAdmin
);

router.post(
  '/:id/reserve',
  requirePermission(PERMISSIONS.ORDER_RESERVE),
  validate(reserveSchema),
  controller.reserveFuel
);

router.post(
  '/:id/release',
  requirePermission(PERMISSIONS.ORDER_RESERVE),
  validate(releaseSchema),
  controller.releaseFuel
);

export default router;
