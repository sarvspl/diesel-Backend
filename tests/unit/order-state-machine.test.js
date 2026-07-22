import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  allowedTransitionsFrom,
  canTransition,
  isTerminal,
  TRANSITION_TABLE,
} from '../../src/modules/order/state-machine.js';
import {
  ACTOR_KIND,
  CUSTOMER_CANCELLABLE_STATUSES,
  ORDER_STATUS,
  OUTCOME_RECORDED_STATUSES,
  TERMINAL_STATUSES,
} from '../../src/shared/constants/order.js';

/**
 * The order state machine.
 *
 * docs/07 §11 sets the bar: "Every arrow in §3 succeeds" and "A representative
 * sample of unlisted pairs is rejected". This does better than a sample - it
 * enumerates EVERY pair of states and asserts that exactly those in the table
 * are allowed, which is the assertion that a table-driven machine makes
 * possible and a chain of `if` statements does not.
 */

const ALL = Object.values(ORDER_STATUS);
const { CUSTOMER, DRIVER, ADMIN, SYSTEM } = ACTOR_KIND;

describe('the transition table', () => {
  it('lists only known statuses on both sides', () => {
    for (const entry of TRANSITION_TABLE) {
      assert.ok(ALL.includes(entry.from), `unknown from: ${entry.from}`);
      assert.ok(ALL.includes(entry.to), `unknown to: ${entry.to}`);
    }
  });

  it('never lists a self-transition', () => {
    for (const entry of TRANSITION_TABLE) {
      assert.notEqual(entry.from, entry.to, `${entry.from} -> itself`);
    }
  });

  it('never leaves a terminal state', () => {
    for (const entry of TRANSITION_TABLE) {
      assert.ok(
        !TERMINAL_STATUSES.includes(entry.from),
        `${entry.from} is terminal but has an outgoing arrow to ${entry.to}`
      );
    }
  });

  it('gives every transition at least one permitted actor and a reason', () => {
    for (const entry of TRANSITION_TABLE) {
      assert.ok(entry.actors.length > 0, `${entry.from} -> ${entry.to} has no actors`);
      assert.ok(entry.reason?.length > 0, `${entry.from} -> ${entry.to} has no reason`);
    }
  });

  it('has no duplicate rows', () => {
    const seen = new Set();

    for (const entry of TRANSITION_TABLE) {
      const key = `${entry.from}|${entry.to}`;
      assert.ok(!seen.has(key), `duplicate row: ${key}`);
      seen.add(key);
    }
  });

  it('leaves every non-terminal status with somewhere to go', () => {
    // A non-terminal state with no exit is an order that can never finish -
    // the silent-death case the dwell-time watchdog exists to catch (BR-811).
    for (const status of ALL.filter((entry) => !TERMINAL_STATUSES.includes(entry))) {
      assert.ok(
        allowedTransitionsFrom(status).length > 0,
        `${status} is not terminal but has no outgoing transitions`
      );
    }
  });

  it('makes every status reachable from DRAFT', () => {
    // Breadth-first over the table. An unreachable status is dead vocabulary
    // that will eventually be "fixed" by someone adding a wrong arrow.
    const seen = new Set([ORDER_STATUS.DRAFT]);
    const queue = [ORDER_STATUS.DRAFT];

    while (queue.length > 0) {
      const current = queue.shift();

      for (const { to } of allowedTransitionsFrom(current)) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }

    for (const status of ALL) {
      assert.ok(seen.has(status), `${status} is unreachable from DRAFT`);
    }
  });
});

describe('every documented arrow succeeds (docs/07 §3)', () => {
  /** The main flow, exactly as the diagram draws it. */
  const MAIN_FLOW = [
    [ORDER_STATUS.DRAFT, ORDER_STATUS.PENDING_PAYMENT, CUSTOMER],
    [ORDER_STATUS.DRAFT, ORDER_STATUS.CONFIRMED, CUSTOMER],
    [ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.CONFIRMED, SYSTEM],
    [ORDER_STATUS.PENDING_PAYMENT, ORDER_STATUS.PAYMENT_FAILED, SYSTEM],
    [ORDER_STATUS.PAYMENT_FAILED, ORDER_STATUS.PENDING_PAYMENT, CUSTOMER],
    [ORDER_STATUS.CONFIRMED, ORDER_STATUS.ALLOCATING, SYSTEM],
    [ORDER_STATUS.ALLOCATING, ORDER_STATUS.ASSIGNED, SYSTEM],
    [ORDER_STATUS.ALLOCATING, ORDER_STATUS.ALLOCATION_FAILED, SYSTEM],
    [ORDER_STATUS.ALLOCATION_FAILED, ORDER_STATUS.ASSIGNED, ADMIN],
    [ORDER_STATUS.ASSIGNED, ORDER_STATUS.EN_ROUTE, DRIVER],
    [ORDER_STATUS.EN_ROUTE, ORDER_STATUS.ARRIVED, DRIVER],
    [ORDER_STATUS.ARRIVED, ORDER_STATUS.DISPENSING, DRIVER],
    [ORDER_STATUS.DISPENSING, ORDER_STATUS.DELIVERED, DRIVER],
    [ORDER_STATUS.DISPENSING, ORDER_STATUS.PARTIALLY_DELIVERED, DRIVER],
    [ORDER_STATUS.DELIVERED, ORDER_STATUS.CLOSED, SYSTEM],
    [ORDER_STATUS.PARTIALLY_DELIVERED, ORDER_STATUS.CLOSED, SYSTEM],
  ];

  for (const [from, to, actorKind] of MAIN_FLOW) {
    it(`${from} -> ${to} by ${actorKind}`, () => {
      assert.equal(canTransition({ from, to, actorKind }).allowed, true);
    });
  }

  it('DELIVERED is NOT terminal - money has not settled yet', () => {
    assert.equal(isTerminal(ORDER_STATUS.DELIVERED), false);
    assert.equal(isTerminal(ORDER_STATUS.CLOSED), true);
  });

  it('PARTIALLY_DELIVERED is a first-class outcome, not an error state', () => {
    // ADR-009: expected on 10-30% of orders. It reaches CLOSED by the same
    // route DELIVERED does.
    assert.equal(
      canTransition({
        from: ORDER_STATUS.PARTIALLY_DELIVERED,
        to: ORDER_STATUS.CLOSED,
        actorKind: SYSTEM,
      }).allowed,
      true
    );
  });
});

describe('illegal transitions are rejected', () => {
  /**
   * EXHAUSTIVE. Every ordered pair of statuses is checked against the table.
   *
   * This is the test docs/07 §10.2 is really asking for: "QA should be able to
   * assert that every unlisted pair is rejected."
   */
  it('rejects every pair that is not in the table', () => {
    const legal = new Set(TRANSITION_TABLE.map((entry) => `${entry.from}|${entry.to}`));
    let checked = 0;

    for (const from of ALL) {
      for (const to of ALL) {
        if (from === to) continue;

        const anyActorAllowed = [CUSTOMER, DRIVER, ADMIN, SYSTEM].some(
          (actorKind) => canTransition({ from, to, actorKind }).allowed
        );

        assert.equal(
          anyActorAllowed,
          legal.has(`${from}|${to}`),
          `${from} -> ${to} disagrees with the table`
        );

        checked += 1;
      }
    }

    // 17 statuses -> 272 ordered pairs. Guards against the loop silently
    // covering nothing if the enum is emptied.
    assert.ok(checked > 250, `only ${checked} pairs checked`);
  });

  it('rejects the two named in docs/07 §11', () => {
    const backwards = canTransition({
      from: ORDER_STATUS.DELIVERED,
      to: ORDER_STATUS.ASSIGNED,
      actorKind: ADMIN,
    });

    assert.equal(backwards.allowed, false);
    assert.equal(backwards.code, 'ILLEGAL');

    // CLOSED -> anything.
    for (const to of ALL) {
      if (to === ORDER_STATUS.CLOSED) continue;

      const verdict = canTransition({ from: ORDER_STATUS.CLOSED, to, actorKind: ADMIN });
      assert.equal(verdict.allowed, false, `CLOSED -> ${to} was allowed`);
      assert.equal(verdict.code, 'TERMINAL');
    }
  });

  it('refuses a transition to the state the order is already in', () => {
    const verdict = canTransition({
      from: ORDER_STATUS.CONFIRMED,
      to: ORDER_STATUS.CONFIRMED,
      actorKind: ADMIN,
    });

    assert.equal(verdict.allowed, false);
    assert.equal(verdict.code, 'SAME_STATE');
  });

  it('reports a terminal source distinctly from an illegal pair', () => {
    // The two need different HTTP answers: "the order is finished" versus
    // "that is not a thing an order can do".
    for (const from of TERMINAL_STATUSES) {
      const verdict = canTransition({ from, to: ORDER_STATUS.ALLOCATING, actorKind: ADMIN });

      assert.equal(verdict.code, 'TERMINAL', from);
    }
  });
});

describe('actor authorisation (docs/07 §11)', () => {
  it('a customer cannot drive a driver-only transition', () => {
    const verdict = canTransition({
      from: ORDER_STATUS.ASSIGNED,
      to: ORDER_STATUS.EN_ROUTE,
      actorKind: CUSTOMER,
    });

    assert.equal(verdict.allowed, false);
    // WRONG_ACTOR, not ILLEGAL: the arrow exists, this actor may not use it.
    // The service maps this to 403 and ILLEGAL to 409.
    assert.equal(verdict.code, 'WRONG_ACTOR');
  });

  it('a driver cannot cancel an order', () => {
    for (const to of [ORDER_STATUS.CANCELLED_BY_CUSTOMER, ORDER_STATUS.CANCELLED_BY_ADMIN]) {
      const verdict = canTransition({ from: ORDER_STATUS.ASSIGNED, to, actorKind: DRIVER });

      assert.equal(verdict.allowed, false, to);
    }
  });

  it('a customer cannot cancel as if they were an operator', () => {
    // The distinction is not cosmetic: it decides the refund policy and what
    // support sees when they ask who cancelled this.
    const verdict = canTransition({
      from: ORDER_STATUS.CONFIRMED,
      to: ORDER_STATUS.CANCELLED_BY_ADMIN,
      actorKind: CUSTOMER,
    });

    assert.equal(verdict.allowed, false);
  });

  it('only SYSTEM may expire an order', () => {
    for (const actorKind of [CUSTOMER, DRIVER, ADMIN]) {
      const verdict = canTransition({
        from: ORDER_STATUS.PENDING_PAYMENT,
        to: ORDER_STATUS.EXPIRED,
        actorKind,
      });

      assert.equal(verdict.allowed, false, actorKind);
      assert.equal(verdict.code, 'WRONG_ACTOR');
    }

    assert.equal(
      canTransition({
        from: ORDER_STATUS.PENDING_PAYMENT,
        to: ORDER_STATUS.EXPIRED,
        actorKind: SYSTEM,
      }).allowed,
      true
    );
  });

  it('an order cannot expire once it is confirmed', () => {
    // Confirmed means the money question is answered. Expiring here would take
    // fuel back from an order that has been paid for.
    assert.equal(
      canTransition({
        from: ORDER_STATUS.CONFIRMED,
        to: ORDER_STATUS.EXPIRED,
        actorKind: SYSTEM,
      }).allowed,
      false
    );
  });
});

describe('cancellation (docs/07 §5)', () => {
  it('lets a customer cancel from exactly the documented set', () => {
    for (const from of ALL) {
      const allowed = canTransition({
        from,
        to: ORDER_STATUS.CANCELLED_BY_CUSTOMER,
        actorKind: CUSTOMER,
      }).allowed;

      assert.equal(
        allowed,
        CUSTOMER_CANCELLABLE_STATUSES.includes(from),
        `customer cancellation from ${from}`
      );
    }
  });

  it('blocks the customer once a tanker is moving (BR-1202)', () => {
    for (const from of [ORDER_STATUS.EN_ROUTE, ORDER_STATUS.ARRIVED, ORDER_STATUS.DISPENSING]) {
      assert.equal(
        canTransition({ from, to: ORDER_STATUS.CANCELLED_BY_CUSTOMER, actorKind: CUSTOMER })
          .allowed,
        false,
        from
      );
    }
  });

  it('lets an admin cancel from every state where no outcome is recorded yet', () => {
    const cancellable = ALL.filter(
      (status) => !TERMINAL_STATUSES.includes(status) && !OUTCOME_RECORDED_STATUSES.includes(status)
    );

    for (const from of cancellable) {
      assert.equal(
        canTransition({ from, to: ORDER_STATUS.CANCELLED_BY_ADMIN, actorKind: ADMIN }).allowed,
        true,
        `admin cancellation from ${from}`
      );
    }

    // Not vacuous - there must be a real set here.
    assert.ok(cancellable.length >= 10, `only ${cancellable.length} cancellable states`);
  });

  it('lets an admin cancel mid-dispensing - a genuine equipment fault', () => {
    assert.equal(
      canTransition({
        from: ORDER_STATUS.DISPENSING,
        to: ORDER_STATUS.CANCELLED_BY_ADMIN,
        actorKind: ADMIN,
      }).allowed,
      true
    );
  });

  it('refuses cancellation once an outcome is recorded (BR-1207)', () => {
    /**
     * The contradiction inside docs/07 §5, pinned.
     *
     * "The administrator can cancel from any non-terminal state" would allow
     * this; "Not cancellable at all: DELIVERED · PARTIALLY_DELIVERED · CLOSED"
     * forbids it. BR-1207 is the numbered rule and it wins - fuel that left the
     * tanker cannot be un-delivered by a status change.
     */
    for (const from of OUTCOME_RECORDED_STATUSES) {
      for (const to of [ORDER_STATUS.CANCELLED_BY_CUSTOMER, ORDER_STATUS.CANCELLED_BY_ADMIN]) {
        for (const actorKind of [ADMIN, CUSTOMER, SYSTEM]) {
          assert.equal(
            canTransition({ from, to, actorKind }).allowed,
            false,
            `${from} -> ${to} by ${actorKind}`
          );
        }
      }
    }
  });

  it('closes a recorded outcome instead of cancelling it', () => {
    // The route out of those states is reconciliation, and it exists.
    for (const from of OUTCOME_RECORDED_STATUSES) {
      assert.equal(
        canTransition({ from, to: ORDER_STATUS.CLOSED, actorKind: SYSTEM }).allowed,
        true,
        from
      );
    }
  });
});

describe('allowedTransitionsFrom', () => {
  it('filters by actor', () => {
    const forDriver = allowedTransitionsFrom(ORDER_STATUS.ARRIVED, DRIVER).map((e) => e.to);
    const forCustomer = allowedTransitionsFrom(ORDER_STATUS.ARRIVED, CUSTOMER).map((e) => e.to);

    assert.ok(forDriver.includes(ORDER_STATUS.DISPENSING));
    assert.equal(forCustomer.length, 0);
  });

  it('returns nothing from a terminal state', () => {
    for (const status of TERMINAL_STATUSES) {
      assert.deepEqual(allowedTransitionsFrom(status, ADMIN), [], status);
    }
  });

  it('carries the documented reason, which the admin UI renders', () => {
    const [first] = allowedTransitionsFrom(ORDER_STATUS.DISPENSING, DRIVER);

    assert.ok(first.reason.length > 0);
  });
});
