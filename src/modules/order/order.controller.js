import {
  ACTOR_KIND,
  RESERVATION_RELEASE_REASON,
  RESERVATION_STATUS,
} from '../../shared/constants/order.js';
import { sendCreated, sendSuccess } from '../../shared/utils/api-response.js';
import * as reservationService from '../dispatch/services/reservation.service.js';
import * as idempotencyService from '../platform/services/idempotency.service.js';

import * as cancelService from './services/cancel-order.service.js';
import { createOrder } from './services/create-order.service.js';
import * as queryService from './services/order-query.service.js';
import { toAdminOrder } from './services/order-view.js';
import { transitionOrder } from './services/transition-order.service.js';

/**
 * HTTP layer for ordering.
 *
 * Thin by rule (docs/11 §1.3): read validated input, call a service, shape the
 * response. The acting user always comes from `req.auth`, never the body - an
 * order's actor is what the audit trail is built from, and a self-declared one
 * is not an audit trail.
 */

// --- Customer ---------------------------------------------------------------

/**
 * POST /api/v1/orders
 *
 * The idempotent one (BR-803). The service returns a full `{ status, body }`
 * rather than a resource, because the idempotency layer stores that response
 * and replays it verbatim on a retry - including its status code.
 */
export const placeOrder = async (req, res) => {
  const result = await idempotencyService.runOnce({
    key: req.idempotencyKey,
    userId: req.auth.userId,
    endpoint: 'POST /orders',
    body: req.validated.body,
    operation: () =>
      createOrder({
        userId: req.auth.userId,
        requestId: req.id,
        ...req.validated.body,
      }),
  });

  // A replay carries the original status. A client that branched on 201 the
  // first time must behave identically on the retry it was told to make.
  return res.status(result.status).json(result.body);
};

/** GET /api/v1/orders */
export const listOrders = async (req, res) => {
  const result = await queryService.listOwnOrders({
    userId: req.auth.userId,
    ...req.validated.query,
  });

  return sendSuccess(res, { message: 'Orders retrieved', data: result });
};

/** GET /api/v1/orders/:id */
export const getOrder = async (req, res) => {
  const order = await queryService.getOwnOrder({
    orderId: req.validated.params.id,
    userId: req.auth.userId,
  });

  return sendSuccess(res, { message: 'Order retrieved', data: { order } });
};

/** POST /api/v1/orders/:id/cancel */
export const cancelOrder = async (req, res) => {
  const order = await cancelService.cancelOwnOrder({
    orderId: req.validated.params.id,
    userId: req.auth.userId,
    requestId: req.id,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Order cancelled', data: { order } });
};

/** GET /api/v1/orders/:id/history */
export const getOrderHistory = async (req, res) => {
  const result = await queryService.getOwnOrderTimeline({
    orderId: req.validated.params.id,
    userId: req.auth.userId,
  });

  return sendSuccess(res, { message: 'Order history retrieved', data: result });
};

// --- Admin ------------------------------------------------------------------

/** GET /api/v1/admin/orders */
export const listAllOrders = async (req, res) => {
  const result = await queryService.listAllOrders(req.validated.query);

  return sendSuccess(res, { message: 'Orders retrieved', data: result });
};

/** GET /api/v1/admin/orders/:id */
export const getOrderForAdmin = async (req, res) => {
  const result = await queryService.getOrderForAdmin(req.validated.params.id);

  return sendSuccess(res, { message: 'Order retrieved', data: result });
};

/** GET /api/v1/admin/orders/:id/history */
export const getAdminOrderHistory = async (req, res) => {
  const result = await queryService.getAdminOrderTimeline(req.validated.params.id);

  return sendSuccess(res, { message: 'Order history retrieved', data: result });
};

/**
 * POST /api/v1/admin/orders/:id/transition
 *
 * Drives a LEGAL transition by hand. It is not a status setter: the request
 * goes through the same transition function as everything else, so the table,
 * the actor rules, the side effects and the timeline all apply identically.
 */
export const transition = async (req, res) => {
  const order = await transitionOrder({
    orderId: req.validated.params.id,
    actorKind: ACTOR_KIND.ADMIN,
    actorUserId: req.auth.userId,
    requestId: req.id,
    ...req.validated.body,
  });

  return sendSuccess(res, {
    message: 'Order transitioned',
    data: { order: toAdminOrder(order) },
  });
};

/** POST /api/v1/admin/orders/:id/cancel */
export const cancelOrderAsAdmin = async (req, res) => {
  const order = await cancelService.cancelAsAdmin({
    orderId: req.validated.params.id,
    actorUserId: req.auth.userId,
    requestId: req.id,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Order cancelled', data: { order } });
};

/** POST /api/v1/admin/orders/:id/reserve */
export const reserveFuel = async (req, res) => {
  const order = await queryService.getOrderForAdmin(req.validated.params.id);

  const reservation = await reservationService.reserve({
    orderId: req.validated.params.id,
    quantity: order.order.quantity,
    vehicleId: req.validated.body.vehicleId,
    actorUserId: req.auth.userId,
  });

  return sendCreated(res, {
    message: 'Fuel reserved',
    data: { reservation: reservationService.toAdminReservation(reservation) },
  });
};

/** POST /api/v1/admin/orders/:id/release */
export const releaseFuel = async (req, res) => {
  const reservation = await reservationService.releaseForOrder({
    orderId: req.validated.params.id,
    reason: req.validated.body.reason ?? RESERVATION_RELEASE_REASON.ADMIN_RELEASE,
    status: RESERVATION_STATUS.RELEASED,
  });

  return sendSuccess(res, {
    message: reservation ? 'Fuel reservation released' : 'That order holds no reservation',
    data: {
      reservation: reservation ? reservationService.toAdminReservation(reservation) : null,
    },
  });
};
