import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideCorporateAccess } from '../../src/modules/corporate/services/corporate-gate.js';
import {
  evaluateAccountGates,
  registerAccountGate,
  __resetAccountGates,
} from '../../src/modules/identity/services/account-gate.js';

/**
 * The corporate login gate enforces BR-203 and BR-209, so its decision is
 * tested exhaustively across the status axes rather than only through HTTP.
 *
 * `decideCorporateAccess` is a pure function of the caller's memberships,
 * which is why no database or module mocking is needed here.
 */

const membership = (verificationStatus, accountStatus) => ({
  id: 'm-1',
  role: 'CORPORATE_OWNER',
  corporateAccountId: 'c-1',
  corporateAccount: {
    id: 'c-1',
    displayName: 'Acme Fuels',
    verificationStatus,
    accountStatus,
    creditFacilityStatus: 'NOT_ENABLED',
  },
});

describe('corporate login gate decision', () => {
  it('allows a user with no corporate membership', () => {
    // A retail customer must be entirely unaffected by corporate rules.
    assert.equal(decideCorporateAccess([]), null);
  });

  it('allows APPROVED + ACTIVE', () => {
    assert.equal(decideCorporateAccess([membership('APPROVED', 'ACTIVE')]), null);
  });

  it('blocks PENDING with a distinct reason', () => {
    const denial = decideCorporateAccess([membership('PENDING', 'INACTIVE')]);

    assert.equal(denial.code, 'CORPORATE_VERIFICATION_PENDING');
  });

  it('blocks REJECTED with a distinct reason', () => {
    const denial = decideCorporateAccess([membership('REJECTED', 'INACTIVE')]);

    assert.equal(denial.code, 'CORPORATE_VERIFICATION_REJECTED');
  });

  it('blocks APPROVED + SUSPENDED on the operational axis', () => {
    // The company is still verified. Only the second axis moved (BR-213), and
    // the reason reported must reflect that rather than claiming a
    // verification problem.
    const denial = decideCorporateAccess([membership('APPROVED', 'SUSPENDED')]);

    assert.equal(denial.code, 'CORPORATE_ACCOUNT_SUSPENDED');
  });

  it('blocks APPROVED + INACTIVE', () => {
    const denial = decideCorporateAccess([membership('APPROVED', 'INACTIVE')]);

    assert.equal(denial.code, 'CORPORATE_ACCOUNT_INACTIVE');
  });

  it('allows when ANY membership is usable', () => {
    const denial = decideCorporateAccess([
      membership('REJECTED', 'INACTIVE'),
      membership('APPROVED', 'ACTIVE'),
    ]);

    // The usable company is the one they are signing in to use.
    assert.equal(denial, null);
  });

  it('reports the most actionable reason when several block', () => {
    const denial = decideCorporateAccess([
      membership('REJECTED', 'INACTIVE'),
      membership('PENDING', 'INACTIVE'),
    ]);

    // A pending review resolves itself; a rejection does not.
    assert.equal(denial.code, 'CORPORATE_VERIFICATION_PENDING');
  });

  it('gives every blocking state its own code', () => {
    const codes = new Set(
      [
        ['PENDING', 'INACTIVE'],
        ['REJECTED', 'INACTIVE'],
        ['APPROVED', 'SUSPENDED'],
        ['APPROVED', 'INACTIVE'],
      ].map(
        ([verification, account]) => decideCorporateAccess([membership(verification, account)]).code
      )
    );

    // Four blocking states, four codes. A single generic failure is
    // indistinguishable from a broken login (docs/10 §4.4).
    assert.equal(codes.size, 4);
  });

  it('never blocks on the credit axis', () => {
    // Credit is orthogonal: a company with no credit facility still logs in
    // and pays by other means (BR-230).
    for (const credit of ['NOT_ENABLED', 'SUSPENDED', 'CLOSED']) {
      const member = membership('APPROVED', 'ACTIVE');
      member.corporateAccount.creditFacilityStatus = credit;

      assert.equal(decideCorporateAccess([member]), null, `credit ${credit} must not block login`);
    }
  });
});

describe('account gate registry', () => {
  it('returns the first denial and does not run later gates', async () => {
    __resetAccountGates();

    let secondRan = false;
    registerAccountGate('first', async () => ({ code: 'NOPE', message: 'no' }));
    registerAccountGate('second', async () => {
      secondRan = true;
      return null;
    });

    const denial = await evaluateAccountGates({ id: 'u-1' });

    assert.equal(denial.code, 'NOPE');
    assert.equal(secondRan, false);
    __resetAccountGates();
  });

  it('registration is idempotent by name', async () => {
    __resetAccountGates();

    let calls = 0;
    const gate = async () => {
      calls += 1;
      return null;
    };

    registerAccountGate('dupe', gate);
    registerAccountGate('dupe', gate);
    await evaluateAccountGates({ id: 'u-1' });

    assert.equal(calls, 1);
    __resetAccountGates();
  });

  it('a throwing gate fails the login closed', async () => {
    __resetAccountGates();

    registerAccountGate('broken', async () => {
      throw new Error('database unavailable');
    });

    // "Could not check" must never become "allowed" - that would turn a
    // database blip into an authorisation bypass.
    await assert.rejects(() => evaluateAccountGates({ id: 'u-1' }), /database unavailable/);
    __resetAccountGates();
  });

  it('allows when no gates are registered', async () => {
    __resetAccountGates();

    assert.equal(await evaluateAccountGates({ id: 'u-1' }), null);
  });
});
