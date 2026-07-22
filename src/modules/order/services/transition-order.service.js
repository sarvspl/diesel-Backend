import { prisma } from '../../../infrastructure/database/prisma.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import {
  ACTOR_KIND,
  ORDER_STATUS,
  RESERVATION_RELEASE_REASON,
  RESERVATION_STATUS,
} from '../../../shared/constants/order.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as reservationService from '../../dispatch/services/reservation.service.js';
import * as outboxService from '../../platform/services/outbox.service.js';
import { AGGREGATE, ORDER_EVENTS, orderEventPayload } from '../order.events.js';
import * as orderRepository from '../repositories/order.repository.js';
import { canTransition } from '../state-machine.js';

const log = createLogger({ module: 'order.transition' });

/**
 * THE SINGLE TRANSITION FUNCTION.
 *
 * docs/06 §9 and docs/07 §10.1 both state the constraint in the same words:
 * "Exactly one function transitions order status. Nothing else anywhere writes
 * order status. Every serious bug in systems of this shape traces back to a
 * second code path that skipped a check."
 *
 * So this is the only caller of `orderRepository.applyTransition`, and that is
 * the only function that writes `orders.status`. Cancellation, expiry, payment
 * confirmation and the admin endpoint all come through here. None of them has
 * its own update.
 *
 * WHAT IT DOES, IN ORDER (docs/07 §10.1):
 *
 *   1. Read the order.
 *   2. Validate the transition against the legal-transition table.
 *   3. Open a transaction.
 *   4. Claim the transition conditionally - compare-and-set on the status the
 *      caller believed it was in.
 *   5. Run side effects INSIDE that transaction.
 *   6. Append a status event with actor, reason and metadata.
 *   7. Write outbox events for anything the outside world must learn about.
 *
 * WHAT IT DOES NOT DO: call anything external. No push, no SMS, no gateway, no
 * HTTP. Those are outbox rows drained afterwards, because an external call
 * inside a transaction holds database locks for the duration of a third party's
 * response (docs/08 §8.2, ADR-012).
 */

/**
 * Side effects that must happen as part of reaching a given state.
 *
 * A table rather than a switch inside the transaction, for the same reason the
 * transition table is a table: it is reviewable, and adding a state cannot
 * silently inherit another state's behaviour.
 *
 * Each returns outbox events to publish. They must not perform external calls.
 */
const SIDE_EFFECTS = {
  /**
   * Cancelling and expiring both give the fuel back (BR-1203, BR-1006).
   *
   * The release happens through the dispatch service, which runs its own
   * transaction. That is a deliberate exception to "one transaction" and it is
   * worth being explicit about: `settle` locks the vehicle inventory row, and
   * holding that lock for the whole order transaction would serialise every
   * order on that tanker behind this one. The reservation release is idempotent
   * and independently conditional, so the worst case if the order transaction
   * then fails is a released reservation on a still-live order - which the
   * sweeper and the allocator both tolerate, and which is far cheaper than the
   * contention.
   */
  [ORDER_STATUS.CANCELLED_BY_CUSTOMER]: RESERVATION_RELEASE_REASON.ORDER_CANCELLED,
  [ORDER_STATUS.CANCELLED_BY_ADMIN]: RESERVATION_RELEASE_REASON.ORDER_CANCELLED,
  [ORDER_STATUS.EXPIRED]: RESERVATION_RELEASE_REASON.ORDER_EXPIRED,
  [ORDER_STATUS.DELIVERY_FAILED]: RESERVATION_RELEASE_REASON.DELIVERY_FAILED,

  /**
   * ALLOCATING is listed with NO release, deliberately, because it is reachable
   * two ways and this table can only see the destination:
   *
   *   CONFIRMED -> ALLOCATING   the normal path. The reservation made at
   *                             placement must SURVIVE - dropping it here would
   *                             hand the fuel back seconds after promising it.
   *   ASSIGNED  -> ALLOCATING   re-allocation after a driver went dark (F11).
   *                             This one SHOULD move the hold to another
   *                             vehicle.
   *
   * Releasing on the destination alone would break the first case to serve the
   * second, so it releases on neither. Re-allocation is Dispatch's job and it
   * will release explicitly when that module exists; recorded as debt rather
   * than guessed at here.
   */
  [ORDER_STATUS.ALLOCATING]: null,
};

/** Which additional column writes a target state implies. */
const patchFor = ({ toStatus, actorKind, actorUserId, reason }) => {
  switch (toStatus) {
    case ORDER_STATUS.CANCELLED_BY_CUSTOMER:
    case ORDER_STATUS.CANCELLED_BY_ADMIN:
      return {
        cancelledAt: new Date(),
        cancelledByUserId: actorUserId ?? null,
        cancelledByKind: actorKind,
        cancellationReason: reason,
      };

    case ORDER_STATUS.EXPIRED:
      return {
        cancelledAt: new Date(),
        cancelledByKind: ACTOR_KIND.SYSTEM,
        cancellationReason: reason,
      };

    case ORDER_STATUS.CONFIRMED:
      // Confirmed means the money question is answered, so the expiry clock
      // stops. Leaving it set would let the sweeper expire a paid order.
      return { expiresAt: null };

    default:
      return {};
  }
};

/**
 * Move an order to a new status.
 *
 * @param {object} params
 * @param {string} params.orderId
 * @param {string} params.toStatus
 * @param {string} params.actorKind      One of ACTOR_KIND.
 * @param {string} [params.actorUserId]  Required unless actorKind is SYSTEM.
 * @param {string} params.reason         Why. Never optional in practice.
 * @param {object} [params.metadata]
 * @param {string} [params.requestId]
 * @param {string} [params.expectedStatus] Refuse unless the order is in this
 *   state. Lets a caller that already read the order detect a concurrent change.
 * @returns {Promise<object>} the updated order
 */
export const transitionOrder = async ({
  orderId,
  toStatus,
  actorKind,
  actorUserId = null,
  reason,
  metadata = null,
  requestId = null,
  expectedStatus,
}) => {
  const order = await orderRepository.findById(orderId);

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  const fromStatus = order.status;

  if (expectedStatus && fromStatus !== expectedStatus) {
    throw new ConflictError(`The order is no longer ${expectedStatus}`, {
      code: ERROR_CODES.INVALID_STATE_TRANSITION,
      details: { currentStatus: fromStatus },
    });
  }

  const verdict = canTransition({ from: fromStatus, to: toStatus, actorKind });

  if (!verdict.allowed) {
    /**
     * WRONG_ACTOR is a 403 and everything else is a 409, and the distinction
     * matters to a client: "you may not do that" is answered by using a
     * different account, "the order has moved on" is answered by refreshing.
     * Collapsing both into one code makes the app retry the wrong thing.
     */
    if (verdict.code === 'WRONG_ACTOR') {
      throw new ForbiddenError(verdict.message, {
        code: ERROR_CODES.TRANSITION_NOT_PERMITTED,
        details: { from: fromStatus, to: toStatus },
      });
    }

    throw new ConflictError(verdict.message, {
      code:
        verdict.code === 'TERMINAL'
          ? ERROR_CODES.ORDER_ALREADY_TERMINAL
          : ERROR_CODES.INVALID_STATE_TRANSITION,
      details: { from: fromStatus, to: toStatus },
    });
  }

  const releaseReason = SIDE_EFFECTS[toStatus];

  /**
   * Reservation release happens BEFORE the order transaction opens.
   *
   * Ordering matters here and the choice is not obvious. Releasing first means
   * a failure of the order transaction leaves the fuel released on a live
   * order; releasing after would mean holding the vehicle inventory lock across
   * the order write. The first is recoverable by the allocator and the sweeper;
   * the second serialises every order on that tanker. See the note on
   * SIDE_EFFECTS above.
   */
  let releasedReservation = null;

  if (releaseReason) {
    releasedReservation = await reservationService.releaseForOrder({
      orderId,
      reason: releaseReason,
      status:
        releaseReason === RESERVATION_RELEASE_REASON.ORDER_EXPIRED
          ? RESERVATION_STATUS.EXPIRED
          : RESERVATION_STATUS.RELEASED,
    });
  }

  const result = await prisma.$transaction(async (tx) => {
    const claimed = await orderRepository.applyTransition(tx, {
      orderId,
      // The compare-and-set. Another transaction that moved this order between
      // our read and this write wins, and we get zero rows rather than
      // clobbering a decision we never saw (docs/08 §9.5).
      expectedStatus: fromStatus,
      toStatus,
      patch: patchFor({ toStatus, actorKind, actorUserId, reason }),
    });

    if (claimed === 0) return { won: false };

    await orderRepository.appendStatusEvent(tx, {
      orderId,
      fromStatus,
      toStatus,
      actorKind,
      actorUserId: actorKind === ACTOR_KIND.SYSTEM ? null : actorUserId,
      reason: reason ?? verdict.transition.reason,
      metadata: {
        ...(metadata ?? {}),
        ...(releasedReservation ? { releasedReservationId: releasedReservation.id } : {}),
      },
      requestId,
    });

    const events = [
      {
        aggregate: AGGREGATE,
        aggregateId: orderId,
        eventType: ORDER_EVENTS.STATUS_CHANGED,
        payload: orderEventPayload(
          { ...order, status: toStatus },
          { fromStatus, toStatus, actorKind, reason }
        ),
      },
    ];

    // The named events consumers actually subscribe to (docs/09 §22). A
    // consumer should not have to inspect `order.status.changed` payloads to
    // discover that an order was cancelled.
    if (toStatus === ORDER_STATUS.CONFIRMED) {
      events.push({
        aggregate: AGGREGATE,
        aggregateId: orderId,
        eventType: ORDER_EVENTS.CONFIRMED,
        payload: orderEventPayload({ ...order, status: toStatus }),
      });
      // Ordering asks; Dispatch allocates. It never calls Dispatch inline.
      events.push({
        aggregate: AGGREGATE,
        aggregateId: orderId,
        eventType: ORDER_EVENTS.ALLOCATION_REQUESTED,
        payload: orderEventPayload({ ...order, status: toStatus }),
      });
    }

    if (
      toStatus === ORDER_STATUS.CANCELLED_BY_CUSTOMER ||
      toStatus === ORDER_STATUS.CANCELLED_BY_ADMIN
    ) {
      events.push({
        aggregate: AGGREGATE,
        aggregateId: orderId,
        eventType: ORDER_EVENTS.CANCELLED,
        payload: orderEventPayload(
          { ...order, status: toStatus },
          { cancelledByKind: actorKind, reason }
        ),
      });
    }

    if (toStatus === ORDER_STATUS.EXPIRED) {
      events.push({
        aggregate: AGGREGATE,
        aggregateId: orderId,
        eventType: ORDER_EVENTS.EXPIRED,
        payload: orderEventPayload({ ...order, status: toStatus }, { reason }),
      });
    }

    await outboxService.publishAll(tx, events);

    return { won: true };
  });

  if (!result.won) {
    throw new ConflictError('That order changed while your request was being processed', {
      code: ERROR_CODES.INVALID_STATE_TRANSITION,
      details: { from: fromStatus, to: toStatus },
    });
  }

  // Every state transition is logged with its actor (docs/11 §6.4).
  log.info(
    { orderId, from: fromStatus, to: toStatus, actorKind, actorUserId },
    'order transitioned'
  );

  return orderRepository.findById(orderId);
};
