import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertVehicleUsableForShift,
  assessDispatchability,
} from '../../src/modules/fleet/services/dispatchability.service.js';
import { DISPATCH_BLOCKER } from '../../src/shared/constants/fleet.js';

/**
 * BR-402 is a legal requirement, not a preference: dispensing on a vehicle
 * whose calibration certificate has lapsed is a Legal Metrology offence. This
 * is the function Dispatch will call, so it is tested exhaustively.
 *
 * It is pure and takes `now` as a parameter, which is what makes the expiry
 * boundaries testable to the day.
 */

const NOW = new Date('2026-07-20T10:00:00.000Z');
const future = new Date('2027-01-01T00:00:00.000Z');
const past = new Date('2026-01-01T00:00:00.000Z');

const vehicle = (overrides = {}) => ({
  status: 'ACTIVE',
  calibrationExpiry: future,
  pesoLicenseExpiry: future,
  insuranceExpiry: future,
  pucExpiry: future,
  fitnessExpiry: future,
  ...overrides,
});

const inventory = (overrides = {}) => ({
  currentQuantity: '5000',
  heldQuantity: '0',
  staleAfter: future,
  ...overrides,
});

describe('vehicle dispatchability', () => {
  it('a compliant, active, crewed, fuelled vehicle is dispatchable', () => {
    const result = assessDispatchability({
      vehicle: vehicle(),
      inventory: inventory(),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.equal(result.dispatchable, true);
    assert.deepEqual(result.blockers, []);
  });

  it('blocks an expired calibration certificate (BR-402)', () => {
    const result = assessDispatchability({
      vehicle: vehicle({ calibrationExpiry: past }),
      inventory: inventory(),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.equal(result.dispatchable, false);
    assert.ok(result.blockers.includes(DISPATCH_BLOCKER.CALIBRATION_EXPIRED));
    // HARD: an operator must not be able to override it.
    assert.ok(result.hardBlockers.includes(DISPATCH_BLOCKER.CALIBRATION_EXPIRED));
  });

  it('blocks an expired PESO licence (BR-402)', () => {
    const result = assessDispatchability({
      vehicle: vehicle({ pesoLicenseExpiry: past }),
      inventory: inventory(),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.ok(result.hardBlockers.includes(DISPATCH_BLOCKER.PESO_EXPIRED));
  });

  it('a certificate is still valid on its expiry DAY', () => {
    // The off-by-one that would strand a legally compliant vehicle: an expiry
    // date lapses at the end of its day, not at midnight that morning.
    const today = new Date('2026-07-20T00:00:00.000Z');

    const result = assessDispatchability({
      vehicle: vehicle({ calibrationExpiry: today }),
      inventory: inventory(),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.equal(result.dispatchable, true, 'must still be valid at 10:00 on the expiry day');
  });

  it('a certificate has lapsed the day after', () => {
    const result = assessDispatchability({
      vehicle: vehicle({ calibrationExpiry: new Date('2026-07-19T00:00:00.000Z') }),
      inventory: inventory(),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.equal(result.dispatchable, false);
  });

  it('treats a null expiry as not-expired', () => {
    // A vehicle with no recorded certificate is a data-quality problem, not an
    // expired one. Reporting it as expired would be a misleading reason.
    const result = assessDispatchability({
      vehicle: vehicle({ calibrationExpiry: null, pesoLicenseExpiry: null }),
      inventory: inventory(),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.equal(result.dispatchable, true);
  });

  it('blocks a non-ACTIVE vehicle (BR-403)', () => {
    for (const status of ['MAINTENANCE', 'INACTIVE']) {
      const result = assessDispatchability({
        vehicle: vehicle({ status }),
        inventory: inventory(),
        hasActiveDriver: true,
        now: NOW,
      });

      assert.ok(result.blockers.includes(DISPATCH_BLOCKER.NOT_ACTIVE), status);
    }
  });

  it('reports RETIRED distinctly from merely inactive', () => {
    const result = assessDispatchability({
      vehicle: vehicle({ status: 'RETIRED' }),
      inventory: inventory(),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.ok(result.blockers.includes(DISPATCH_BLOCKER.RETIRED));
    assert.ok(!result.blockers.includes(DISPATCH_BLOCKER.NOT_ACTIVE));
  });

  it('blocks with no driver assigned, but softly', () => {
    const result = assessDispatchability({
      vehicle: vehicle(),
      inventory: inventory(),
      hasActiveDriver: false,
      now: NOW,
    });

    assert.equal(result.dispatchable, false);
    // Soft: an operator may assign someone and proceed.
    assert.ok(result.softBlockers.includes(DISPATCH_BLOCKER.NO_DRIVER_ASSIGNED));
    assert.equal(result.hardBlockers.length, 0);
  });

  it('blocks on stale fuel state, softly (BR-409)', () => {
    const result = assessDispatchability({
      vehicle: vehicle(),
      inventory: inventory({ staleAfter: past }),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.ok(result.softBlockers.includes(DISPATCH_BLOCKER.FUEL_STATE_STALE));
  });

  it('blocks an empty tank', () => {
    const result = assessDispatchability({
      vehicle: vehicle(),
      inventory: inventory({ currentQuantity: '0' }),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.ok(result.blockers.includes(DISPATCH_BLOCKER.NO_AVAILABLE_FUEL));
  });

  it('counts held fuel as unavailable (BR-405)', () => {
    // Everything in the tank is already promised to other orders.
    const result = assessDispatchability({
      vehicle: vehicle(),
      inventory: inventory({ currentQuantity: '500', heldQuantity: '500' }),
      hasActiveDriver: true,
      now: NOW,
    });

    assert.ok(result.blockers.includes(DISPATCH_BLOCKER.NO_AVAILABLE_FUEL));
  });

  it('reports every blocker, not just the first', () => {
    const result = assessDispatchability({
      vehicle: vehicle({ status: 'MAINTENANCE', calibrationExpiry: past, insuranceExpiry: past }),
      inventory: inventory({ currentQuantity: '0' }),
      hasActiveDriver: false,
      now: NOW,
    });

    // An operator fixing one problem at a time, discovering the next each
    // round, is a bad experience and a slow one.
    assert.ok(result.blockers.length >= 5, `only found ${result.blockers.join(', ')}`);
  });
});

describe('vehicle usable for a shift', () => {
  it('allows an empty, unassigned but compliant vehicle', () => {
    // A shift may legitimately begin with an empty tank - the driver is going
    // to a depot - and the assignment is what starting the shift confirms.
    const result = assertVehicleUsableForShift({ vehicle: vehicle(), now: NOW });

    assert.equal(result.usable, true);
  });

  it('refuses a vehicle whose calibration has lapsed', () => {
    const result = assertVehicleUsableForShift({
      vehicle: vehicle({ calibrationExpiry: past }),
      now: NOW,
    });

    assert.equal(result.usable, false);
    assert.ok(result.blockers.includes(DISPATCH_BLOCKER.CALIBRATION_EXPIRED));
  });

  it('refuses a retired vehicle', () => {
    const result = assertVehicleUsableForShift({
      vehicle: vehicle({ status: 'RETIRED' }),
      now: NOW,
    });

    assert.equal(result.usable, false);
  });

  it('ignores a lapsed PUC, which is soft', () => {
    const result = assertVehicleUsableForShift({
      vehicle: vehicle({ pucExpiry: past }),
      now: NOW,
    });

    assert.equal(result.usable, true, 'an emissions certificate is a compliance task, not a block');
  });
});
