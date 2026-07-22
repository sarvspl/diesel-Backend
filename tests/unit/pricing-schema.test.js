import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createDeliveryChargeSchema,
  createPriceSchema,
  createProductSchema,
  createQuoteSchema,
  createTaxSchema,
  updatePriceStatusSchema,
  updateProductSchema,
} from '../../src/modules/pricing/pricing.schema.js';

const VALID_UUID = '01984f2c-8a3b-7c1d-9e4f-2a6b8c0d1e3f';
const FUTURE = '2027-01-01T00:00:00.000Z';
const LATER = '2027-06-01T00:00:00.000Z';

describe('product schema', () => {
  const valid = { code: 'hsd', name: 'High-Speed Diesel' };

  it('accepts a valid product and upper-cases the code', () => {
    const result = createProductSchema.body.safeParse(valid);

    assert.equal(result.success, true);
    assert.equal(result.data.code, 'HSD');
  });

  it('rejects a code with punctuation - it is a machine identifier', () => {
    for (const code of ['HS D', 'HSD-1', 'hsd!', 'H']) {
      assert.equal(createProductSchema.body.safeParse({ ...valid, code }).success, false, code);
    }
  });

  it('defaults the unit to litres', () => {
    assert.equal(createProductSchema.body.safeParse(valid).data.unit, 'LITRE');
  });

  it('will not rename a code on update - seeds and reports reference it', () => {
    const result = updateProductSchema.body.safeParse({ code: 'PETROL', name: 'Petrol' });

    // `code` is stripped rather than rejected; the point is that it cannot reach
    // the service, so no update path can change it.
    assert.equal(result.success, true);
    assert.equal(result.data.code, undefined);
  });

  it('rejects an empty update', () => {
    assert.equal(updateProductSchema.body.safeParse({}).success, false);
  });
});

describe('price schema', () => {
  const valid = { productId: VALID_UUID, city: 'Mumbai', pricePerUnit: '94.77' };

  it('accepts a valid price', () => {
    assert.equal(createPriceSchema.body.safeParse(valid).success, true);
  });

  it('keeps the rate as a string', () => {
    // A JSON number is a double in every client. 94.77 is not representable in
    // binary, and this is the value every order is priced from.
    assert.equal(typeof createPriceSchema.body.safeParse(valid).data.pricePerUnit, 'string');
  });

  it('rejects a numeric rate', () => {
    assert.equal(
      createPriceSchema.body.safeParse({ ...valid, pricePerUnit: 94.77 }).success,
      false
    );
  });

  it('rejects zero, negative and non-numeric rates', () => {
    for (const pricePerUnit of ['0', '-1', '0.0000', 'abc', '', '1.2.3']) {
      assert.equal(
        createPriceSchema.body.safeParse({ ...valid, pricePerUnit }).success,
        false,
        pricePerUnit
      );
    }
  });

  it('allows four decimals but not five', () => {
    assert.equal(
      createPriceSchema.body.safeParse({ ...valid, pricePerUnit: '94.7712' }).success,
      true
    );
    assert.equal(
      createPriceSchema.body.safeParse({ ...valid, pricePerUnit: '94.77123' }).success,
      false
    );
  });

  it('will not accept a status of SUPERSEDED', () => {
    // Superseding is a consequence of publishing a newer version. Choosing it
    // directly would leave a gap in the timeline with no price in force.
    assert.equal(updatePriceStatusSchema.body.safeParse({ status: 'SUPERSEDED' }).success, false);
    assert.equal(updatePriceStatusSchema.body.safeParse({ status: 'ACTIVE' }).success, true);
  });

  it('will not accept PENDING_APPROVAL as a target status', () => {
    // Parking a price is decided by the sanity band, not by the caller.
    assert.equal(
      updatePriceStatusSchema.body.safeParse({ status: 'PENDING_APPROVAL' }).success,
      false
    );
  });
});

describe('tax rule schema', () => {
  const valid = {
    name: 'Maharashtra VAT (diesel)',
    code: 'MH_VAT_DIESEL',
    regime: 'VAT_EXCISE',
    appliesTo: 'FUEL',
    isInclusive: true,
    rate: '24',
    effectiveFrom: FUTURE,
  };

  it('accepts a valid rule', () => {
    assert.equal(createTaxSchema.body.safeParse(valid).success, true);
  });

  it('requires regime, appliesTo and isInclusive - none may be defaulted', () => {
    // A rule that does not say which line it attaches to, and whether it is
    // already inside the price, cannot be applied correctly (BR-703-705).
    for (const field of ['regime', 'appliesTo', 'isInclusive']) {
      const body = { ...valid };
      delete body[field];

      assert.equal(createTaxSchema.body.safeParse(body).success, false, field);
    }
  });

  it('rejects a percentage above 100', () => {
    assert.equal(createTaxSchema.body.safeParse({ ...valid, rate: '101' }).success, false);
    assert.equal(createTaxSchema.body.safeParse({ ...valid, rate: '100' }).success, true);
  });

  it('allows a per-unit rate above 100 - it is rupees per litre, not a percentage', () => {
    const result = createTaxSchema.body.safeParse({
      ...valid,
      calculationType: 'PER_UNIT',
      rate: '150.50',
    });

    assert.equal(result.success, true);
  });

  it('allows a zero rate for an exempt rule', () => {
    assert.equal(
      createTaxSchema.body.safeParse({ ...valid, regime: 'EXEMPT', rate: '0' }).success,
      true
    );
  });

  it('rejects a negative rate - a negative tax is a discount', () => {
    assert.equal(createTaxSchema.body.safeParse({ ...valid, rate: '-5' }).success, false);
  });

  it('rejects an end date before the start', () => {
    assert.equal(
      createTaxSchema.body.safeParse({ ...valid, effectiveFrom: LATER, effectiveUntil: FUTURE })
        .success,
      false
    );
  });

  it('rejects an end date equal to the start - an empty window', () => {
    assert.equal(
      createTaxSchema.body.safeParse({ ...valid, effectiveUntil: FUTURE }).success,
      false
    );
  });
});

describe('delivery charge schema', () => {
  const valid = {
    name: 'Mumbai standard delivery',
    flatCharge: '250.00',
    effectiveFrom: FUTURE,
  };

  it('accepts a valid rule', () => {
    assert.equal(createDeliveryChargeSchema.body.safeParse(valid).success, true);
  });

  it('allows a free delivery rule', () => {
    assert.equal(
      createDeliveryChargeSchema.body.safeParse({ ...valid, flatCharge: '0' }).success,
      true
    );
  });

  it('rejects a negative charge', () => {
    assert.equal(
      createDeliveryChargeSchema.body.safeParse({ ...valid, flatCharge: '-1' }).success,
      false
    );
  });

  it('rejects a quantity band that ends below where it starts', () => {
    const result = createDeliveryChargeSchema.body.safeParse({
      ...valid,
      minQuantity: '500',
      maxQuantity: '100',
    });

    assert.equal(result.success, false);
  });

  it('defaults to the FLAT type and a global scope', () => {
    const result = createDeliveryChargeSchema.body.safeParse(valid);

    assert.equal(result.data.chargeType, 'FLAT');
    assert.equal(result.data.city, undefined);
  });
});

describe('quote schema', () => {
  const valid = { addressId: VALID_UUID, productId: VALID_UUID, quantity: '100' };

  it('accepts a valid request', () => {
    assert.equal(createQuoteSchema.body.safeParse(valid).success, true);
  });

  it('has no price field - the server computes it (BR-603)', () => {
    const result = createQuoteSchema.body.safeParse({
      ...valid,
      pricePerUnit: '1.00',
      totalAmount: '1.00',
    });

    // Stripped, so a client-supplied price cannot reach the quote engine even
    // if someone later spreads the body into the service call.
    assert.equal(result.success, true);
    assert.equal(result.data.pricePerUnit, undefined);
    assert.equal(result.data.totalAmount, undefined);
  });

  it('rejects a zero or negative quantity', () => {
    for (const quantity of ['0', '-1', '0.000']) {
      assert.equal(createQuoteSchema.body.safeParse({ ...valid, quantity }).success, false);
    }
  });

  it('rejects a numeric quantity', () => {
    assert.equal(createQuoteSchema.body.safeParse({ ...valid, quantity: 100 }).success, false);
  });

  it('rejects an implausibly large order rather than letting it reach the tanker', () => {
    assert.equal(createQuoteSchema.body.safeParse({ ...valid, quantity: '999999' }).success, false);
  });

  it('rejects a non-UUID address', () => {
    assert.equal(
      createQuoteSchema.body.safeParse({ ...valid, addressId: 'not-a-uuid' }).success,
      false
    );
  });
});
