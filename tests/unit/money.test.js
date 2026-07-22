import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  add,
  Decimal,
  divide,
  extractInclusiveTax,
  multiply,
  percentOf,
  round,
  sum,
  toDecimal,
  toMoneyString,
  toQuantityString,
} from '../../src/shared/utils/money.js';

/**
 * Money arithmetic (ADR-004 control M1).
 *
 * These tests are deliberately blunt: they assert the exact behaviours that
 * floating point gets wrong, because that is the only failure mode this module
 * exists to prevent and it is invisible without a test that names it.
 */

describe('toDecimal', () => {
  it('rejects a JS number outright', () => {
    // The important case. Accepting it would hide a precision loss that already
    // happened upstream, which is worse than failing here.
    assert.throws(() => toDecimal(84.5), TypeError);
    assert.throws(() => toDecimal(0), TypeError);
  });

  it('accepts strings, Decimals and Prisma-style objects', () => {
    assert.equal(toDecimal('84.5').toString(), '84.5');
    assert.equal(toDecimal(new Decimal('84.5')).toString(), '84.5');
    assert.equal(toDecimal({ toString: () => '84.5' }).toString(), '84.5');
  });

  it('rejects null and undefined rather than treating them as zero', () => {
    assert.throws(() => toDecimal(null), TypeError);
    assert.throws(() => toDecimal(undefined), TypeError);
  });
});

describe('exact arithmetic', () => {
  it('adds without binary floating-point error', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE 754. This is the whole point.
    assert.equal(add('0.1', '0.2').toString(), '0.3');
  });

  it('multiplies a rate by a quantity exactly', () => {
    // 3 litres at 94.77 is 284.31, not 284.31000000000006.
    assert.equal(multiply('3', '94.77').toString(), '284.31');
  });

  it('sums an empty list to zero - an empty invoice is valid, not an error', () => {
    assert.equal(sum([]).toString(), '0');
  });

  it('sums strings and Decimals together', () => {
    assert.equal(sum(['1.01', new Decimal('2.02'), '3.03']).toString(), '6.06');
  });
});

describe('rounding (BR-708 half-up)', () => {
  it('rounds a half up, not to even', () => {
    // Banker's rounding would give 2.02 here and 2.04 below. Indian invoicing
    // requires half-up, and a library default change must not alter totals.
    assert.equal(toMoneyString('2.025'), '2.03');
    assert.equal(toMoneyString('2.035'), '2.04');
  });

  it('formats to a fixed scale, always as a string', () => {
    assert.equal(toMoneyString('84'), '84.00');
    assert.equal(toMoneyString('84.1'), '84.10');
    assert.equal(toQuantityString('20'), '20.000');
  });

  it('keeps quantities at three decimals - litres to the millilitre', () => {
    assert.equal(toQuantityString('19.9995'), '20.000');
    assert.equal(toQuantityString('19.9994'), '19.999');
  });

  it('does not round intermediate values to the money scale', () => {
    // A division that terminates must survive a round trip exactly.
    assert.equal(multiply(divide('1', '8'), '8').toString(), '1');

    // And one that does not terminate must keep its full working precision
    // rather than being clipped to 2dp on the way through. (It cannot be
    // exact - 1/3 has no finite decimal form - but it must not be 0.33.)
    const third = divide('1', '3');
    assert.ok(third.decimalPlaces() > 30, `lost precision: ${third.toString()}`);
  });
});

describe('percentOf - the EXCLUSIVE case (delivery, BR-702)', () => {
  it('adds tax on top of a net base', () => {
    // 18% GST on a 250.00 delivery charge.
    assert.equal(toMoneyString(percentOf('250', '18')), '45.00');
  });

  it('is zero at a zero rate', () => {
    assert.equal(toMoneyString(percentOf('250', '0')), '0.00');
  });
});

describe('extractInclusiveTax - the INCLUSIVE case (diesel, BR-705)', () => {
  /**
   * THE mistake this function exists to prevent.
   *
   * The pump rate already contains VAT. Tax must be DERIVED from it, not added
   * to it. `gross * percent` is the intuitive wrong answer and it overstates
   * tax on every fuel line ever invoiced.
   */
  it('derives tax from the gross rather than adding it', () => {
    const { taxable, tax } = extractInclusiveTax('1000', '25');

    assert.equal(toMoneyString(taxable), '800.00');
    assert.equal(toMoneyString(tax), '200.00');

    // The wrong answer, named explicitly so a regression cannot claim to be
    // "close enough": 25% OF 1000 is 250, and it is 50 rupees too much.
    assert.notEqual(toMoneyString(tax), '250.00');
  });

  it('reconstructs the gross exactly - taxable + tax === gross', () => {
    const { taxable, tax } = extractInclusiveTax('9477.31', '25.4');

    assert.equal(add(taxable, tax).toString(), '9477.31');
  });

  it('extracts nothing at a zero rate', () => {
    const { taxable, tax } = extractInclusiveTax('1000', '0');

    assert.equal(taxable.toString(), '1000');
    assert.equal(tax.toString(), '0');
  });
});

describe('round', () => {
  it('rounds to an explicit scale', () => {
    assert.equal(round('1.23456', 4).toString(), '1.2346');
    assert.equal(round('1.23456', 0).toString(), '1');
  });
});
