import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createVehicleSchema,
  endShiftSchema,
  manualAdjustmentSchema,
  meterReadingSchema,
  refillSchema,
  startShiftSchema,
  updateVehicleSchema,
} from '../../src/modules/fleet/fleet.schema.js';

const VALID_UUID = '01984f2c-8a3b-7c1d-9e4f-2a6b8c0d1e3f';

describe('vehicle schema', () => {
  const valid = {
    vehicleNumber: 'TKR-04',
    registrationNumber: 'WB12AB3456',
    tankCapacity: '12000.000',
  };

  it('accepts a valid vehicle', () => {
    assert.equal(createVehicleSchema.body.safeParse(valid).success, true);
  });

  it('keeps capacity as a string', () => {
    const result = createVehicleSchema.body.safeParse(valid);

    // A JSON number is a double in every client; rounding a fuel quantity is
    // how a tanker ends up recorded as empty with litres still in it.
    assert.equal(typeof result.data.tankCapacity, 'string');
  });

  it('rejects a numeric capacity', () => {
    assert.equal(
      createVehicleSchema.body.safeParse({ ...valid, tankCapacity: 12000 }).success,
      false
    );
  });

  it('rejects a zero or negative capacity', () => {
    for (const tankCapacity of ['0', '0.000', '-500']) {
      assert.equal(
        createVehicleSchema.body.safeParse({ ...valid, tankCapacity }).success,
        false,
        tankCapacity
      );
    }
  });

  it('rejects an opening quantity above the tank capacity at the service layer', () => {
    // The schema allows it (both are valid quantities); the service compares
    // them. Asserted here so the split is deliberate and documented.
    const result = createVehicleSchema.body.safeParse({
      ...valid,
      tankCapacity: '1000',
      openingFuelQuantity: '5000',
    });

    assert.equal(result.success, true, 'schema-level pass; the service rejects the combination');
  });

  it('normalises identifiers to upper case', () => {
    const result = createVehicleSchema.body.safeParse({
      ...valid,
      vehicleNumber: 'tkr-04',
      registrationNumber: 'wb12ab3456',
    });

    assert.equal(result.data.vehicleNumber, 'TKR-04');
    assert.equal(result.data.registrationNumber, 'WB12AB3456');
  });

  it('parses compliance expiries as dates', () => {
    const result = createVehicleSchema.body.safeParse({
      ...valid,
      calibrationExpiry: '2027-03-31',
    });

    assert.ok(result.data.calibrationExpiry instanceof Date);
  });

  it('rejects an impossible date', () => {
    assert.equal(
      createVehicleSchema.body.safeParse({ ...valid, calibrationExpiry: '2027-13-45' }).success,
      false
    );
  });

  it('requires a reason when retiring', () => {
    // Retirement is irreversible; an unexplained one is unauditable.
    assert.equal(updateVehicleSchema.body.safeParse({ status: 'RETIRED' }).success, false);
    assert.equal(
      updateVehicleSchema.body.safeParse({ status: 'RETIRED', retiredReason: 'Sold' }).success,
      true
    );
  });

  it('rejects an empty patch', () => {
    assert.equal(updateVehicleSchema.body.safeParse({}).success, false);
  });
});

describe('refill schema', () => {
  const valid = { quantity: '4500.000', depotName: 'IOC Budge Budge' };

  it('accepts a valid refill', () => {
    assert.equal(refillSchema.body.safeParse(valid).success, true);
  });

  it('rejects a zero or negative quantity', () => {
    // A refill is always an increase; a negative one would be a stock
    // reduction with none of the scrutiny a manual decrease attracts.
    for (const quantity of ['0', '-100']) {
      assert.equal(refillSchema.body.safeParse({ ...valid, quantity }).success, false, quantity);
    }
  });

  it('requires a depot', () => {
    assert.equal(refillSchema.body.safeParse({ quantity: '100' }).success, false);
  });

  it('rejects a future occurrence', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();

    assert.equal(refillSchema.body.safeParse({ ...valid, occurredAt: tomorrow }).success, false);
  });
});

describe('manual adjustment schema', () => {
  const valid = {
    direction: 'DECREASE',
    quantity: '35.500',
    reasonCode: 'LEAK_DETECTED',
    reason: 'Seal failure on compartment 2 found during the morning inspection.',
  };

  it('accepts a fully explained adjustment', () => {
    assert.equal(manualAdjustmentSchema.body.safeParse(valid).success, true);
  });

  it('requires both a reason code and a reason', () => {
    // An unexplained stock reduction is indistinguishable from theft, and this
    // is the endpoint that would be used to conceal one.
    const { reason: _r, ...noReason } = valid;
    const { reasonCode: _c, ...noCode } = valid;

    assert.equal(manualAdjustmentSchema.body.safeParse(noReason).success, false);
    assert.equal(manualAdjustmentSchema.body.safeParse(noCode).success, false);
  });

  it('rejects a token reason', () => {
    assert.equal(
      manualAdjustmentSchema.body.safeParse({ ...valid, reason: 'oops' }).success,
      false
    );
  });

  it('normalises the reason code', () => {
    const result = manualAdjustmentSchema.body.safeParse({ ...valid, reasonCode: 'leak_detected' });

    assert.equal(result.data.reasonCode, 'LEAK_DETECTED');
  });

  it('requires an explicit direction', () => {
    const { direction: _d, ...noDirection } = valid;

    assert.equal(manualAdjustmentSchema.body.safeParse(noDirection).success, false);
    assert.equal(
      manualAdjustmentSchema.body.safeParse({ ...valid, direction: 'SIDEWAYS' }).success,
      false
    );
  });

  it('takes an unsigned quantity - the service applies the sign', () => {
    assert.equal(
      manualAdjustmentSchema.body.safeParse({ ...valid, quantity: '-35' }).success,
      false
    );
  });
});

describe('meter reading schema', () => {
  const valid = { totalizer: '123456.750', photoKey: 'meter/abc.jpg' };

  it('accepts a valid reading', () => {
    assert.equal(meterReadingSchema.body.safeParse(valid).success, true);
  });

  it('requires a photograph (BR-906)', () => {
    // A manual reading without evidence is an unverifiable claim, and a
    // database CHECK enforces the same rule.
    const { photoKey: _p, ...noPhoto } = valid;

    assert.equal(meterReadingSchema.body.safeParse(noPhoto).success, false);
  });

  it('accepts a large lifetime totaliser', () => {
    // Totalisers accumulate for the life of the meter and must not be capped
    // at a tank-sized value.
    assert.equal(
      meterReadingSchema.body.safeParse({ ...valid, totalizer: '98765432101.500' }).success,
      true
    );
  });

  it('rejects a negative totaliser', () => {
    assert.equal(meterReadingSchema.body.safeParse({ ...valid, totalizer: '-5' }).success, false);
  });

  it('defaults to a spot check', () => {
    assert.equal(meterReadingSchema.body.safeParse(valid).data.readingType, 'SPOT_CHECK');
  });
});

describe('shift schemas', () => {
  const start = {
    driverProfileId: VALID_UUID,
    vehicleId: VALID_UUID,
    openingTotalizer: '123456.000',
    photoKey: 'meter/open.jpg',
  };

  it('accepts a valid shift start', () => {
    assert.equal(startShiftSchema.body.safeParse(start).success, true);
  });

  it('requires a meter photograph at shift start', () => {
    // Matches the database CHECK; optional here would surface as an unhandled
    // constraint violation instead of a validation error.
    const { photoKey: _p, ...noPhoto } = start;

    assert.equal(startShiftSchema.body.safeParse(noPhoto).success, false);
  });

  it('requires the opening totaliser (BR-306)', () => {
    const { openingTotalizer: _t, ...noTotalizer } = start;

    assert.equal(startShiftSchema.body.safeParse(noTotalizer).success, false);
  });

  it('requires a photograph at shift end too', () => {
    assert.equal(
      endShiftSchema.body.safeParse({ shiftId: VALID_UUID, closingTotalizer: '123999' }).success,
      false
    );
    assert.equal(
      endShiftSchema.body.safeParse({
        shiftId: VALID_UUID,
        closingTotalizer: '123999',
        photoKey: 'meter/close.jpg',
      }).success,
      true
    );
  });

  it('rejects a non-UUID id', () => {
    assert.equal(startShiftSchema.body.safeParse({ ...start, vehicleId: 'nope' }).success, false);
  });
});
