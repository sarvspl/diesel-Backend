import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertBreakdownBalances,
  calculateQuoteBreakdown,
} from '../../src/modules/pricing/services/tax-engine.service.js';
import { add, sum, toDecimal, toMoneyString } from '../../src/shared/utils/money.js';

/**
 * The tax engine.
 *
 * The highest-risk pure logic in the platform, so it is tested as a pure
 * function with no database and no clock. Every case here is a real Indian
 * invoicing rule, not a made-up arithmetic exercise: diesel is outside GST and
 * quoted tax-INCLUSIVE, delivery is inside GST and quoted tax-EXCLUSIVE, and
 * getting either inclusivity backwards is wrong on every invoice (BR-701-705).
 */

const PRODUCT = {
  id: 'e0a1c2d3-0000-4000-8000-000000000001',
  code: 'HSD',
  name: 'High-Speed Diesel',
  unit: 'LITRE',
  hsnCode: '27101944',
};

const PRICE = {
  id: 'e0a1c2d3-0000-4000-8000-0000000000f1',
  pricePerUnit: '94.77',
  effectiveFrom: new Date('2026-07-20T00:30:00.000Z'),
};

/** State VAT on diesel: a percentage, already inside the pump rate. */
const VAT = {
  id: 'r1',
  code: 'MH_VAT_DIESEL',
  name: 'Maharashtra VAT (diesel)',
  regime: 'VAT_EXCISE',
  appliesTo: 'FUEL',
  calculationType: 'PERCENTAGE',
  rate: '24',
  isInclusive: true,
  sequence: 20,
};

/** Central excise: a fixed duty per litre, independent of price. */
const EXCISE = {
  id: 'r2',
  code: 'CENTRAL_EXCISE_DIESEL',
  name: 'Central excise (diesel)',
  regime: 'VAT_EXCISE',
  appliesTo: 'FUEL',
  calculationType: 'PER_UNIT',
  rate: '15.80',
  isInclusive: true,
  sequence: 10,
};

/** GST on the delivery service, split into halves as a real invoice is. */
const CGST = {
  id: 'r3',
  code: 'CGST_DELIVERY',
  name: 'CGST (delivery)',
  regime: 'GST',
  appliesTo: 'DELIVERY',
  calculationType: 'PERCENTAGE',
  rate: '9',
  isInclusive: false,
  sequence: 10,
};

const SGST = { ...CGST, id: 'r4', code: 'SGST_DELIVERY', name: 'SGST (delivery)', sequence: 20 };

const breakdownFor = ({ quantity = '100', deliveryCharge = '250', taxRules }) =>
  calculateQuoteBreakdown({
    product: PRODUCT,
    price: PRICE,
    quantity,
    deliveryCharge,
    deliverySacCode: '996511',
    taxRules,
  });

const lineOf = (breakdown, kind) => breakdown.lines.find((line) => line.kind === kind);

describe('fuel line - VAT_EXCISE, tax INCLUSIVE (BR-705)', () => {
  const breakdown = breakdownFor({ taxRules: [VAT, EXCISE, CGST, SGST] });
  const fuel = lineOf(breakdown, 'FUEL');

  it('charges exactly quantity x pump rate - tax is inside, never added', () => {
    // 100 L at 94.77 is 9477.00. If VAT were ADDED the customer would be billed
    // 11751.48 for fuel they can buy at the pump for 9477.
    assert.equal(fuel.lineTotal, '9477.00');
  });

  it('unwinds the percentage from the gross rather than applying it to it', () => {
    // gross / 1.24 = 7642.74…, minus 1580.00 of excise = 6062.74… taxable.
    // The wrong answer here is 9477 * 0.24 = 2274.48 of VAT.
    const vat = fuel.taxComponents.find((component) => component.code === 'MH_VAT_DIESEL');

    assert.equal(vat.amount, '1834.26');
    assert.notEqual(vat.amount, '2274.48');
  });

  it('computes a per-unit duty from quantity, not from price', () => {
    const excise = fuel.taxComponents.find(
      (component) => component.code === 'CENTRAL_EXCISE_DIESEL'
    );

    // 100 L x 15.80 = 1580.00, unchanged by whatever the pump rate is.
    assert.equal(excise.amount, '1580.00');
  });

  it('reports a taxable base that reconstructs the gross', () => {
    // taxable + all tax components === the line total, exactly.
    const reconstructed = add(fuel.taxableAmount, fuel.taxAmount);

    assert.equal(toMoneyString(reconstructed), fuel.lineTotal);
  });

  it('does not apply DELIVERY rules to the fuel line', () => {
    const codes = fuel.taxComponents.map((component) => component.code);

    assert.ok(!codes.includes('CGST_DELIVERY'));
    assert.ok(!codes.includes('SGST_DELIVERY'));
  });
});

describe('delivery line - GST, tax EXCLUSIVE (BR-702)', () => {
  const breakdown = breakdownFor({ taxRules: [VAT, EXCISE, CGST, SGST] });
  const delivery = lineOf(breakdown, 'DELIVERY');

  it('adds tax on top of the quoted charge', () => {
    assert.equal(delivery.taxableAmount, '250.00');
    assert.equal(delivery.taxAmount, '45.00');
    assert.equal(delivery.lineTotal, '295.00');
  });

  it('splits CGST and SGST into equal halves of one 18% charge', () => {
    // Two 9% rules must equal one 18% rule, or a state-split invoice differs
    // from an inter-state one for the same service.
    const amounts = delivery.taxComponents.map((component) => component.amount);

    assert.deepEqual(amounts, ['22.50', '22.50']);
    assert.equal(sum(amounts).toString(), '45');
  });

  it('carries the SAC code a GST service invoice requires (BR-706)', () => {
    assert.equal(delivery.sacCode, '996511');
  });

  it('does not apply FUEL rules to the delivery line', () => {
    const codes = delivery.taxComponents.map((component) => component.code);

    assert.ok(!codes.includes('MH_VAT_DIESEL'));
    assert.ok(!codes.includes('CENTRAL_EXCISE_DIESEL'));
  });
});

describe('totals (INV-09)', () => {
  const breakdown = breakdownFor({ taxRules: [VAT, EXCISE, CGST, SGST] });

  it('adds the fuel and delivery lines and nothing else', () => {
    // 9477.00 + 295.00. The tax total is NOT added again: the fuel tax is
    // already inside the fuel line, so adding it would charge VAT twice.
    assert.equal(breakdown.totals.grandTotal, '9772.00');
  });

  it('reports a tax total that is informational, not additive', () => {
    // 1834.26 + 1580.00 + 45.00
    assert.equal(breakdown.totals.taxAmount, '3459.26');

    const naive = add(breakdown.totals.grandTotal, breakdown.totals.taxAmount);
    assert.notEqual(toMoneyString(naive), breakdown.totals.grandTotal);
  });

  it('balances - the total equals the sum of the displayed lines', () => {
    assert.ok(assertBreakdownBalances(breakdown));
  });

  it('records the price version the quote is locked to (BR-606)', () => {
    assert.equal(breakdown.priceVersion.priceId, PRICE.id);
    assert.equal(breakdown.priceVersion.pricePerUnit, '94.77');
  });

  it('stamps a breakdown version so a stored shape can be migrated', () => {
    assert.equal(breakdown.breakdownVersion, 1);
  });
});

describe('rounding at line level only (BR-708)', () => {
  /**
   * The awkward quantity. 17.777 L at 94.77 is 1684.72629 - a value that must
   * round ONCE, at the line, and whose rounded form must be what the total is
   * built from. Rounding the components and the total independently is how a
   * total stops equalling the sum of its parts.
   */
  const breakdown = breakdownFor({
    quantity: '17.777',
    deliveryCharge: '99.99',
    taxRules: [VAT, EXCISE, CGST, SGST],
  });

  it('rounds the line, not the intermediates', () => {
    assert.equal(lineOf(breakdown, 'FUEL').lineTotal, '1684.73');
  });

  it('still balances on a quantity that does not divide evenly', () => {
    assert.ok(assertBreakdownBalances(breakdown));
  });

  it('builds the total from the rounded line totals the invoice displays', () => {
    const displayed = sum(breakdown.lines.map((line) => line.lineTotal));

    assert.equal(toMoneyString(displayed), breakdown.totals.grandTotal);
  });
});

describe('degenerate configurations', () => {
  it('treats a product with no tax rules as EXEMPT rather than crashing', () => {
    const breakdown = breakdownFor({ taxRules: [] });
    const fuel = lineOf(breakdown, 'FUEL');

    assert.equal(fuel.regime, 'EXEMPT');
    assert.equal(fuel.taxAmount, '0.00');
    // Inclusive-by-default: with no rules the whole gross is the taxable base.
    assert.equal(fuel.taxableAmount, '9477.00');
    assert.equal(breakdown.totals.grandTotal, '9727.00');
  });

  it('handles a waived delivery charge', () => {
    const breakdown = breakdownFor({ deliveryCharge: '0', taxRules: [VAT, CGST, SGST] });
    const delivery = lineOf(breakdown, 'DELIVERY');

    // Zero net means zero GST - not a missing line, which an invoice needs.
    assert.equal(delivery.lineTotal, '0.00');
    assert.equal(delivery.taxAmount, '0.00');
    assert.ok(assertBreakdownBalances(breakdown));
  });

  it('refuses a JS number for quantity', () => {
    assert.throws(() => breakdownFor({ quantity: 100, taxRules: [VAT] }), TypeError);
  });
});

describe('assertBreakdownBalances', () => {
  it('throws when a total has been tampered with', () => {
    const breakdown = breakdownFor({ taxRules: [VAT, CGST, SGST] });
    breakdown.totals.grandTotal = toMoneyString(add(breakdown.totals.grandTotal, '0.01'));

    assert.throws(() => assertBreakdownBalances(breakdown), /does not balance/);
  });

  it('catches a one-paisa drift, not just a gross error', () => {
    const breakdown = breakdownFor({ taxRules: [VAT, CGST, SGST] });
    const drifted = toDecimal(breakdown.totals.grandTotal).minus('0.01');
    breakdown.totals.grandTotal = toMoneyString(drifted);

    assert.throws(() => assertBreakdownBalances(breakdown), /does not balance/);
  });
});
