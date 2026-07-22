import {
  add,
  divide,
  extractInclusiveTax,
  multiply,
  percentOf,
  roundMoney,
  subtract,
  sum,
  toDecimal,
  toMoneyString,
  toQuantityString,
  ZERO,
} from '../../../shared/utils/money.js';

/**
 * The tax engine.
 *
 * THE HIGHEST-RISK PURE LOGIC IN THE PLATFORM (docs/06 §7). It is a pure
 * function - inputs in, breakdown out, no database, no clock, no side effects -
 * precisely so it can be tested exhaustively without infrastructure.
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * High-Speed Diesel in India is OUTSIDE GST: it carries central excise plus
 * state VAT, and the pump rate a customer sees ALREADY CONTAINS them. The
 * delivery charge IS within GST, at 18%, and is quoted before tax.
 *
 * So one invoice spans two regimes with opposite inclusivity (BR-701 - BR-705):
 *
 *   FUEL      VAT_EXCISE   inclusive   tax is EXTRACTED from the amount
 *   DELIVERY  GST          exclusive   tax is ADDED to the amount
 *
 * Applying a single percentage to the whole quote would tax diesel under GST -
 * legally wrong on every invoice - and would overstate tax on the fuel line by
 * adding what is already inside it. BR-704 says explicitly that this is not a
 * simplification that can be corrected later.
 *
 * ROUNDING (BR-708): half-up, at LINE level only. Intermediate values stay at
 * full precision; only the line total is rounded. Rounding inside a line and
 * again at the end compounds error and is how a total stops equalling the sum
 * of its parts (INV-09).
 */

/**
 * @typedef {object} TaxRuleInput
 * @property {string} id
 * @property {string} code
 * @property {string} name
 * @property {'VAT_EXCISE'|'GST'|'EXEMPT'} regime
 * @property {'FUEL'|'DELIVERY'} appliesTo
 * @property {'PERCENTAGE'|'PER_UNIT'} calculationType
 * @property {string} rate            Percentage, or amount per unit.
 * @property {boolean} isInclusive
 * @property {number} sequence
 *
 * @typedef {object} TaxComponent
 * @property {string} code
 * @property {string} name
 * @property {string} regime
 * @property {string} calculationType
 * @property {string} rate
 * @property {boolean} isInclusive
 * @property {string} amount
 */

/**
 * Compute one line's tax.
 *
 * @param {object} params
 * @param {import('decimal.js').Decimal} params.grossOrNet
 *   For an INCLUSIVE line this is the gross (tax already inside). For an
 *   EXCLUSIVE line it is the net taxable base.
 * @param {import('decimal.js').Decimal} params.quantity  For PER_UNIT rules.
 * @param {TaxRuleInput[]} params.rules
 * @returns {{ taxable: import('decimal.js').Decimal, taxTotal: import('decimal.js').Decimal, components: TaxComponent[] }}
 */
const computeLineTax = ({ grossOrNet, quantity, rules }) => {
  const ordered = [...rules].sort((a, b) => a.sequence - b.sequence);
  const components = [];

  const perUnitRules = ordered.filter((rule) => rule.calculationType === 'PER_UNIT');
  const percentRules = ordered.filter((rule) => rule.calculationType === 'PERCENTAGE');

  // Per-unit duties (central excise) are a fixed amount per litre, independent
  // of price. They are computed first because a percentage tax is levied on a
  // base that already includes them.
  const perUnitAmounts = perUnitRules.map((rule) => ({
    rule,
    amount: multiply(quantity, rule.rate),
  }));

  const perUnitTotal = sum(perUnitAmounts.map((entry) => entry.amount));
  const combinedPercent = sum(percentRules.map((rule) => rule.rate));

  const inclusive = ordered.length > 0 && ordered[0].isInclusive;

  let taxable;
  let percentBase;

  if (inclusive) {
    /**
     * The pump rate contains everything. Unwind it:
     *
     *   gross = (base + perUnit) * (1 + pct/100)
     *   base  = gross / (1 + pct/100) - perUnit
     *
     * The percentage tax is then the difference between the gross and the
     * pre-percentage subtotal - NOT `gross * pct`, which is the intuitive
     * mistake and overstates the tax on every line.
     */
    // `taxable` from the helper is the pre-percentage subtotal, which is the
    // base the percentage rules are levied on - not this line's taxable value,
    // which is that base less the per-unit duties. Renamed at the destructure
    // so the distinction cannot be misread.
    ({ taxable: percentBase } = extractInclusiveTax(grossOrNet, combinedPercent));
    taxable = subtract(percentBase, perUnitTotal);
  } else {
    // Exclusive: the amount IS the taxable base and tax is added on top.
    taxable = grossOrNet;
    percentBase = add(taxable, perUnitTotal);
  }

  for (const { rule, amount } of perUnitAmounts) {
    components.push({
      code: rule.code,
      name: rule.name,
      regime: rule.regime,
      calculationType: rule.calculationType,
      rate: toDecimal(rule.rate).toString(),
      isInclusive: rule.isInclusive,
      amount: toMoneyString(amount),
      amountRaw: amount,
    });
  }

  for (const rule of percentRules) {
    // Each percentage rule takes its own share of the same base, so two rules
    // of 9% each equal one of 18% - which is what CGST + SGST must satisfy.
    const amount = inclusive
      ? multiply(percentBase, divide(rule.rate, toDecimal('100')))
      : percentOf(percentBase, rule.rate);

    components.push({
      code: rule.code,
      name: rule.name,
      regime: rule.regime,
      calculationType: rule.calculationType,
      rate: toDecimal(rule.rate).toString(),
      isInclusive: rule.isInclusive,
      amount: toMoneyString(amount),
      amountRaw: amount,
    });
  }

  const taxTotal = sum(components.map((component) => component.amountRaw));

  return { taxable, taxTotal, components };
};

/**
 * Build the full quote breakdown.
 *
 * @param {object} params
 * @param {object} params.product     { id, code, name, unit, hsnCode }
 * @param {object} params.price       { id, pricePerUnit, effectiveFrom }
 * @param {string} params.quantity
 * @param {string} params.deliveryCharge   Tax-exclusive.
 * @param {string|null} params.deliverySacCode
 * @param {TaxRuleInput[]} params.taxRules
 * @returns {object} the frozen breakdown written onto the quote
 */
export const calculateQuoteBreakdown = ({
  product,
  price,
  quantity,
  deliveryCharge,
  deliverySacCode = null,
  taxRules,
}) => {
  const qty = toDecimal(quantity);
  const rate = toDecimal(price.pricePerUnit);

  // --- Fuel line: INCLUSIVE (BR-705) ---------------------------------------
  const fuelGross = multiply(qty, rate);
  const fuelRules = taxRules.filter((rule) => rule.appliesTo === 'FUEL');
  const fuel = computeLineTax({ grossOrNet: fuelGross, quantity: qty, rules: fuelRules });

  const fuelLine = {
    kind: 'FUEL',
    productId: product.id,
    productCode: product.code,
    description: product.name,
    hsnCode: product.hsnCode ?? null,
    unit: product.unit,
    quantity: toQuantityString(qty),
    ratePerUnit: rate.toString(),
    regime: fuelRules[0]?.regime ?? 'EXEMPT',
    isInclusive: true,
    taxableAmount: toMoneyString(fuel.taxable),
    taxComponents: fuel.components.map(({ amountRaw: _raw, ...rest }) => rest),
    taxAmount: toMoneyString(fuel.taxTotal),
    // Inclusive: the gross IS what the customer pays for this line.
    lineTotal: toMoneyString(fuelGross),
  };

  // --- Delivery line: EXCLUSIVE (BR-702, BR-705) ---------------------------
  const deliveryNet = toDecimal(deliveryCharge);
  const deliveryRules = taxRules.filter((rule) => rule.appliesTo === 'DELIVERY');
  const delivery = computeLineTax({
    grossOrNet: deliveryNet,
    quantity: qty,
    rules: deliveryRules,
  });

  const deliveryGross = add(deliveryNet, delivery.taxTotal);

  const deliveryLine = {
    kind: 'DELIVERY',
    description: 'Delivery charge',
    sacCode: deliverySacCode,
    regime: deliveryRules[0]?.regime ?? 'EXEMPT',
    isInclusive: false,
    taxableAmount: toMoneyString(deliveryNet),
    taxComponents: delivery.components.map(({ amountRaw: _raw, ...rest }) => rest),
    taxAmount: toMoneyString(delivery.taxTotal),
    lineTotal: toMoneyString(deliveryGross),
  };

  /**
   * The grand total is the sum of the ROUNDED line totals, not the rounded sum
   * of raw values. INV-09 requires the total to equal the sum of its lines
   * EXACTLY, and the only way to guarantee that is to add the same numbers the
   * invoice will display.
   */
  const lines = [fuelLine, deliveryLine];
  const grandTotal = sum(lines.map((line) => line.lineTotal));

  const taxTotal = sum(lines.map((line) => line.taxAmount));

  return {
    lines,
    totals: {
      fuelAmount: fuelLine.lineTotal,
      deliveryAmount: deliveryLine.lineTotal,
      // Tax already inside the fuel line plus tax added to delivery. Reported
      // for transparency; it is NOT added to the total again.
      taxAmount: toMoneyString(taxTotal),
      grandTotal: toMoneyString(grandTotal),
    },
    priceVersion: {
      priceId: price.id,
      pricePerUnit: rate.toString(),
      effectiveFrom: price.effectiveFrom,
    },
    computedAt: new Date().toISOString(),
    /** Schema version, so a stored breakdown can be migrated if the shape changes. */
    breakdownVersion: 1,
  };
};

/**
 * Assert that a breakdown is internally consistent.
 *
 * INV-09 / control M5: the total must equal the sum of the lines exactly.
 * Called after every calculation rather than trusted, because a rounding
 * regression here produces invoices that are wrong by a few paise and that
 * nobody notices until a tax filing.
 */
export const assertBreakdownBalances = (breakdown) => {
  const lineSum = sum(breakdown.lines.map((line) => line.lineTotal));
  const stated = toDecimal(breakdown.totals.grandTotal);

  if (!lineSum.equals(stated)) {
    throw new Error(
      `Quote breakdown does not balance: lines sum to ${lineSum.toFixed(2)} ` +
        `but the total says ${stated.toFixed(2)}`
    );
  }

  return true;
};

export { ZERO, roundMoney };
