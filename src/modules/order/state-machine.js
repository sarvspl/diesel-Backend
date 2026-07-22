import {
  ACTOR_KIND,
  ORDER_STATUS,
  OUTCOME_RECORDED_STATUSES,
  TERMINAL_STATUSES,
} from '../../shared/constants/order.js';

/**
 * The order state machine.
 *
 * A TABLE, NOT A CHAIN OF CONDITIONALS (docs/07 §10.2). Every legal transition
 * is one row of `TRANSITIONS`; if a pair is not listed, it is illegal. That is
 * the whole design: QA can print this, review it, and assert that every
 * unlisted pair is rejected - none of which is possible against a series of
 * `if` statements scattered through a service.
 *
 * PURE. No database, no clock, no logging. `canTransition` is a function of its
 * arguments and nothing else, which is what lets the 200-odd illegal pairs be
 * enumerated exhaustively in a unit test without any infrastructure
 * (docs/11 §9: "Unit | Pure logic ... state transitions. Aim high specifically
 * here").
 *
 * WHAT THIS FILE DOES NOT DO
 * --------------------------
 * It does not write anything. `transition-order.service.js` is the ONLY code in
 * the platform that writes order status (docs/06 §9, docs/07 §10.1), and it
 * consults this table before doing so. Keeping the decision separate from the
 * write is what makes the decision testable.
 */

const { CUSTOMER, DRIVER, ADMIN, SYSTEM } = ACTOR_KIND;

/**
 * Every legal transition.
 *
 * @typedef {object} Transition
 * @property {string} from
 * @property {string} to
 * @property {string[]} actors   Actor kinds permitted to drive it.
 * @property {string} reason     Why this arrow exists, for the printed table.
 */

/** @type {Transition[]} */
export const TRANSITIONS = Object.freeze([
  // --- Submission (docs/07 §3) ---------------------------------------------
  // A prepaid order goes to the gateway; every other mode is confirmed at once
  // because the money question is already answered.
  {
    from: ORDER_STATUS.DRAFT,
    to: ORDER_STATUS.PENDING_PAYMENT,
    actors: [CUSTOMER, SYSTEM],
    reason: 'Submitted, prepaid - awaiting gateway',
  },
  {
    from: ORDER_STATUS.DRAFT,
    to: ORDER_STATUS.CONFIRMED,
    actors: [CUSTOMER, SYSTEM],
    reason: 'Submitted, COD or held balance',
  },

  // --- Payment (docs/07 §7) ------------------------------------------------
  // Driven by a verified webhook, never by the client's success callback
  // (BR-1001). ADMIN is permitted for manual reconciliation of a payment the
  // webhook never delivered (BR-1005).
  {
    from: ORDER_STATUS.PENDING_PAYMENT,
    to: ORDER_STATUS.CONFIRMED,
    actors: [SYSTEM, ADMIN],
    reason: 'Payment captured',
  },
  {
    from: ORDER_STATUS.PENDING_PAYMENT,
    to: ORDER_STATUS.PAYMENT_FAILED,
    actors: [SYSTEM, ADMIN],
    reason: 'Payment failed (F1)',
  },
  {
    from: ORDER_STATUS.PAYMENT_FAILED,
    to: ORDER_STATUS.PENDING_PAYMENT,
    actors: [CUSTOMER, SYSTEM],
    reason: 'Customer retried payment',
  },

  // --- Allocation (docs/07 §4) ---------------------------------------------
  {
    from: ORDER_STATUS.CONFIRMED,
    to: ORDER_STATUS.ALLOCATING,
    actors: [SYSTEM, ADMIN],
    reason: 'Allocation enqueued',
  },
  {
    from: ORDER_STATUS.ALLOCATING,
    to: ORDER_STATUS.ASSIGNED,
    actors: [SYSTEM, ADMIN],
    reason: 'A driver accepted, or manual assignment',
  },
  {
    from: ORDER_STATUS.ALLOCATING,
    to: ORDER_STATUS.ALLOCATION_FAILED,
    actors: [SYSTEM],
    reason: 'Candidates exhausted (F8, F9)',
  },
  {
    from: ORDER_STATUS.ALLOCATION_FAILED,
    to: ORDER_STATUS.ALLOCATING,
    actors: [SYSTEM, ADMIN],
    reason: 'Retry round',
  },
  {
    from: ORDER_STATUS.ALLOCATION_FAILED,
    to: ORDER_STATUS.ASSIGNED,
    actors: [ADMIN],
    reason: 'One-click manual assignment (docs/07 §4.1)',
  },

  // --- The trip ------------------------------------------------------------
  {
    from: ORDER_STATUS.ASSIGNED,
    to: ORDER_STATUS.EN_ROUTE,
    actors: [DRIVER, ADMIN],
    reason: 'Driver started the trip',
  },
  // F11: a heartbeat gap auto-releases the order back to dispatch rather than
  // stranding the customer behind a dead phone (BR-311).
  {
    from: ORDER_STATUS.ASSIGNED,
    to: ORDER_STATUS.ALLOCATING,
    actors: [SYSTEM, ADMIN],
    reason: 'Driver unreachable - released for re-allocation (F11)',
  },
  {
    from: ORDER_STATUS.EN_ROUTE,
    to: ORDER_STATUS.ARRIVED,
    actors: [DRIVER, SYSTEM, ADMIN],
    reason: 'Geofence entry, or the driver tapped arrived',
  },
  {
    from: ORDER_STATUS.EN_ROUTE,
    to: ORDER_STATUS.ALLOCATING,
    actors: [SYSTEM, ADMIN],
    reason: 'Breakdown or driver failure - re-allocate',
  },
  {
    from: ORDER_STATUS.ARRIVED,
    to: ORDER_STATUS.DISPENSING,
    actors: [DRIVER, ADMIN],
    reason: 'Receiver verified, opening reading captured',
  },
  {
    from: ORDER_STATUS.ARRIVED,
    to: ORDER_STATUS.DELIVERY_FAILED,
    actors: [DRIVER, ADMIN],
    reason: 'Customer absent or site inaccessible (F14, F16)',
  },

  // --- Outcome (docs/07 §3) ------------------------------------------------
  {
    from: ORDER_STATUS.DISPENSING,
    to: ORDER_STATUS.DELIVERED,
    actors: [DRIVER, ADMIN],
    reason: 'Full quantity delivered',
  },
  {
    from: ORDER_STATUS.DISPENSING,
    to: ORDER_STATUS.PARTIALLY_DELIVERED,
    actors: [DRIVER, ADMIN],
    reason: 'Tank full, tanker dry, or stopped (F17, F18)',
  },
  {
    from: ORDER_STATUS.DISPENSING,
    to: ORDER_STATUS.DELIVERY_FAILED,
    actors: [DRIVER, ADMIN],
    reason: 'Equipment failure or spillage (F19)',
  },

  // --- Closing (docs/07 §6) ------------------------------------------------
  // DELIVERED is not terminal. CLOSED is reached only after reconciliation,
  // invoicing and settlement.
  {
    from: ORDER_STATUS.DELIVERED,
    to: ORDER_STATUS.CLOSED,
    actors: [SYSTEM, ADMIN],
    reason: 'Reconciled, invoiced, settled',
  },
  {
    from: ORDER_STATUS.PARTIALLY_DELIVERED,
    to: ORDER_STATUS.CLOSED,
    actors: [SYSTEM, ADMIN],
    reason: 'Reconciled at the actual quantity',
  },
  {
    from: ORDER_STATUS.DELIVERY_FAILED,
    to: ORDER_STATUS.CLOSED,
    actors: [SYSTEM, ADMIN],
    reason: 'Zero billed, refunded in full (BR-921)',
  },

  // --- Expiry (BR-1006, F2) ------------------------------------------------
  // SYSTEM only. An order expires because a clock said so; no human "expires"
  // an order, they cancel it.
  {
    from: ORDER_STATUS.DRAFT,
    to: ORDER_STATUS.EXPIRED,
    actors: [SYSTEM],
    reason: 'Never submitted',
  },
  {
    from: ORDER_STATUS.PENDING_PAYMENT,
    to: ORDER_STATUS.EXPIRED,
    actors: [SYSTEM],
    reason: 'Payment window elapsed (F2)',
  },
  {
    from: ORDER_STATUS.PAYMENT_FAILED,
    to: ORDER_STATUS.EXPIRED,
    actors: [SYSTEM],
    reason: 'Not retried within the window',
  },
]);

/**
 * Customer self-service cancellation (docs/07 §5).
 *
 * Built from the constant rather than written out again, so the two cannot
 * disagree. Only CUSTOMER may drive these: an operator cancelling produces
 * CANCELLED_BY_ADMIN, because "who cancelled this" is a question support and
 * refund policy both need answered correctly.
 */
const CUSTOMER_CANCELLATIONS = [
  ORDER_STATUS.DRAFT,
  ORDER_STATUS.PENDING_PAYMENT,
  ORDER_STATUS.PAYMENT_FAILED,
  ORDER_STATUS.CONFIRMED,
  ORDER_STATUS.ALLOCATING,
  ORDER_STATUS.ALLOCATION_FAILED,
  ORDER_STATUS.ASSIGNED,
].map((from) => ({
  from,
  to: ORDER_STATUS.CANCELLED_BY_CUSTOMER,
  actors: [CUSTOMER],
  reason: 'Customer cancelled before dispatch (BR-1201)',
}));

/**
 * Administrator cancellation, from any state where no outcome has been
 * recorded yet.
 *
 * docs/07 §5 says "The administrator can cancel from any non-terminal state",
 * but the SAME section lists DELIVERED and PARTIALLY_DELIVERED under "Not
 * cancellable at all ... This is a dispute, not a cancellation." Those two
 * statements contradict each other, because neither of those states is
 * terminal. BR-1207 settles it as a numbered rule, and it is the only reading
 * that survives contact with reality - see OUTCOME_RECORDED_STATUSES.
 *
 * DISPENSING IS still included: an equipment fault mid-delivery is a genuine
 * operational event, and the resulting order must bill for whatever was
 * actually dispensed rather than nothing (docs/07 §5).
 */
const ADMIN_CANCELLATIONS = Object.values(ORDER_STATUS)
  .filter(
    (status) => !TERMINAL_STATUSES.includes(status) && !OUTCOME_RECORDED_STATUSES.includes(status)
  )
  .map((from) => ({
    from,
    to: ORDER_STATUS.CANCELLED_BY_ADMIN,
    actors: [ADMIN, SYSTEM],
    reason: 'Operator cancelled, with a reason (BR-1206)',
  }));

/** The complete table. This is the artefact docs/07 §10.2 asks to be printable. */
export const TRANSITION_TABLE = Object.freeze([
  ...TRANSITIONS,
  ...CUSTOMER_CANCELLATIONS,
  ...ADMIN_CANCELLATIONS,
]);

/** `from|to` -> transition, built once. */
const INDEX = new Map(TRANSITION_TABLE.map((entry) => [`${entry.from}|${entry.to}`, entry]));

export const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

/**
 * May this actor move this order from `from` to `to`?
 *
 * Returns a RESULT rather than a boolean, because the caller needs to tell a
 * customer "that order is already delivered" and an operator "you may not drive
 * that transition" - two different HTTP responses that a boolean collapses.
 *
 * @param {object} params
 * @param {string} params.from
 * @param {string} params.to
 * @param {string} params.actorKind One of ACTOR_KIND.
 * @returns {{ allowed: boolean, code?: string, message?: string, transition?: Transition }}
 */
export const canTransition = ({ from, to, actorKind }) => {
  if (from === to) {
    return {
      allowed: false,
      code: 'SAME_STATE',
      message: `The order is already ${to}`,
    };
  }

  if (isTerminal(from)) {
    return {
      allowed: false,
      code: 'TERMINAL',
      message: `${from} is a final state and cannot change`,
    };
  }

  const transition = INDEX.get(`${from}|${to}`);

  if (!transition) {
    return {
      allowed: false,
      code: 'ILLEGAL',
      message: `An order cannot move from ${from} to ${to}`,
    };
  }

  if (!transition.actors.includes(actorKind)) {
    return {
      allowed: false,
      code: 'WRONG_ACTOR',
      message: `A ${actorKind.toLowerCase()} cannot move an order from ${from} to ${to}`,
      transition,
    };
  }

  return { allowed: true, transition };
};

/** Every status reachable from `from` by `actorKind`. Drives the admin UI. */
export const allowedTransitionsFrom = (from, actorKind) =>
  TRANSITION_TABLE.filter(
    (entry) => entry.from === from && (!actorKind || entry.actors.includes(actorKind))
  ).map((entry) => ({ to: entry.to, reason: entry.reason }));
