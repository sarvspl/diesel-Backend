import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import {
  ACTOR_KIND,
  CANCELLATION_REQUEST_STATUSES,
  CUSTOMER_CANCELLABLE_STATUSES,
  ORDER_STATUS,
} from '../../../shared/constants/order.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as orderRepository from '../repositories/order.repository.js';

import { toPublicOrder, toAdminOrder } from './order-view.js';
import { transitionOrder } from './transition-order.service.js';

const log = createLogger({ module: 'order.cancel' });

/**
 * Cancellation (docs/07 §5, BR-1201 - BR-1207).
 *
 * Three tiers, and which one applies depends entirely on the order's state:
 *
 *   before dispatch     the customer cancels freely
 *   tanker in motion    in-app cancellation is BLOCKED; they may only REQUEST
 *                       one, which routes to operations (BR-1202)
 *   after delivery      not a cancellation at all. It is a dispute, resolved
 *                       with a credit note against the invoice (BR-1207)
 *
 * This service does not release the reservation itself. The transition function
 * does, because releasing fuel is a side effect of reaching a cancelled state
 * and putting it here would create a second code path that a future
 * `expireOrder` would have to remember to copy.
 */

/**
 * Customer-initiated cancellation.
 *
 * The order is loaded through the SCOPED repository read, so an order belonging
 * to someone else is indistinguishable from one that does not exist - a 404
 * rather than a 403, because a 403 confirms the id is real (docs/10 §6).
 */
export const cancelOwnOrder = async ({
  orderId,
  userId,
  corporateAccountIds = [],
  reason,
  requestId = null,
}) => {
  const order = await orderRepository.findForUser({ id: orderId, userId, corporateAccountIds });

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  /**
   * BR-1202: once a tanker is moving, cancelling has a cost and becomes an
   * operational decision. The customer is told to request one rather than
   * refused flatly, because "you cannot" and "ask us" are different answers and
   * the app needs to show a different screen for each.
   */
  if (CANCELLATION_REQUEST_STATUSES.includes(order.status)) {
    throw new ConflictError(
      'The driver is already on the way. Contact support to request a cancellation.',
      {
        code: ERROR_CODES.CANCELLATION_REQUIRES_OPERATOR,
        details: { status: order.status },
      }
    );
  }

  if (!CUSTOMER_CANCELLABLE_STATUSES.includes(order.status)) {
    throw new ConflictError(
      order.status === ORDER_STATUS.DELIVERED ||
        order.status === ORDER_STATUS.PARTIALLY_DELIVERED ||
        order.status === ORDER_STATUS.CLOSED
        ? 'That order has already been delivered. Raise a dispute instead.'
        : `An order that is ${order.status} cannot be cancelled`,
      { code: ERROR_CODES.ORDER_NOT_CANCELLABLE, details: { status: order.status } }
    );
  }

  const updated = await transitionOrder({
    orderId,
    toStatus: ORDER_STATUS.CANCELLED_BY_CUSTOMER,
    actorKind: ACTOR_KIND.CUSTOMER,
    actorUserId: userId,
    reason,
    // The status we validated against. If anything moved the order in between,
    // the transition loses the compare-and-set and the customer gets a clean
    // conflict rather than a cancellation of a state we never checked.
    expectedStatus: order.status,
    requestId,
  });

  log.info({ orderId, userId, from: order.status }, 'order cancelled by customer');

  return toPublicOrder(updated);
};

/**
 * Administrator cancellation.
 *
 * Possible from ANY non-terminal state, always with a reason, always audited
 * (BR-1206). Including from DISPENSING: an equipment fault mid-delivery is a
 * genuine operational event, and the resulting order must bill for whatever was
 * actually dispensed rather than nothing (docs/07 §5).
 */
export const cancelAsAdmin = async ({ orderId, actorUserId, reason, requestId = null }) => {
  const order = await orderRepository.findById(orderId);

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  const updated = await transitionOrder({
    orderId,
    toStatus: ORDER_STATUS.CANCELLED_BY_ADMIN,
    actorKind: ACTOR_KIND.ADMIN,
    actorUserId,
    reason,
    expectedStatus: order.status,
    requestId,
  });

  // Logged at warn: an operator cancelling a customer's order is something an
  // auditor and a support agent will both eventually ask about.
  log.warn({ orderId, actorUserId, from: order.status, reason }, 'order cancelled by admin');

  return toAdminOrder(updated);
};

/**
 * Expire orders whose payment window has elapsed (BR-1006, F2).
 *
 * Intended for a scheduled sweep; no scheduler exists yet. Runs as SYSTEM, and
 * appears in every affected order's timeline as SYSTEM - docs/03 §5 is explicit
 * that "when a reservation is released automatically, the timeline must show
 * that, not an unexplained gap".
 */
export const expireLapsedOrders = async () => {
  const lapsed = await orderRepository.findLapsedUnpaid();
  let expired = 0;

  for (const order of lapsed) {
    try {
      await transitionOrder({
        orderId: order.id,
        toStatus: ORDER_STATUS.EXPIRED,
        actorKind: ACTOR_KIND.SYSTEM,
        reason: 'Payment was not completed within the allowed window',
        expectedStatus: order.status,
      });

      expired += 1;
    } catch (error) {
      // One order that moved underneath the sweep must not stop the sweep.
      log.warn({ err: error, orderId: order.id }, 'could not expire a lapsed order');
    }
  }

  if (expired > 0) log.info({ expired }, 'lapsed orders expired');

  return { expired, examined: lapsed.length };
};
