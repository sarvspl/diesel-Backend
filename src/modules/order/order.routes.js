import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { requireIdempotencyKey } from '../../shared/middleware/idempotency.js';
import { validate } from '../../shared/middleware/validate.js';

import * as controller from './order.controller.js';
import {
  cancelOrderSchema,
  createOrderSchema,
  listOrdersSchema,
  orderIdSchema,
} from './order.schema.js';

/**
 * Customer orders.
 *
 * CUSTOMER principal on every route. A driver token must never reach these even
 * if the permissions happened to overlap - customer and driver are separate
 * accounts by design (ADR-016, ADR-021).
 *
 * There is no route that sets a status directly. Cancellation has its own
 * endpoint because it is the only fulfilment transition a customer may drive,
 * and it carries a reason and a canceller that a generic status write would not.
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.CUSTOMER));

/**
 * Idempotency-Key is REQUIRED here and nowhere else in this router (BR-803,
 * docs/10 §8.1). Order creation is the one endpoint where a retry the client
 * makes automatically would otherwise mean a second tanker, a second
 * reservation and a second charge.
 */
router.post(
  '/',
  requirePermission(PERMISSIONS.ORDER_CREATE),
  requireIdempotencyKey,
  validate(createOrderSchema),
  controller.placeOrder
);

router.get(
  '/',
  requirePermission(PERMISSIONS.ORDER_READ),
  validate(listOrdersSchema),
  controller.listOrders
);

router.get(
  '/:id',
  requirePermission(PERMISSIONS.ORDER_READ),
  validate(orderIdSchema),
  controller.getOrder
);

/// The customer timeline (docs/04 §3). Ownership is verified by loading the
/// order through the scoped read before any event is returned.
router.get(
  '/:id/history',
  requirePermission(PERMISSIONS.ORDER_READ),
  validate(orderIdSchema),
  controller.getOrderHistory
);

router.post(
  '/:id/cancel',
  requirePermission(PERMISSIONS.ORDER_CANCEL),
  validate(cancelOrderSchema),
  controller.cancelOrder
);

export default router;
