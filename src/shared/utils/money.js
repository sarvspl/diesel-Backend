import Decimal from 'decimal.js';

/**
 * The ONE place money and quantity arithmetic happens (ADR-004 control M1).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Money is stored as PostgreSQL `NUMERIC` and returned by Prisma as a Decimal
 * object. The moment anyone writes `.toNumber()` and does arithmetic on the
 * result, the platform silently reverts to binary floating point and the exact
 * storage guarantee is gone. It will not fail loudly - it produces a ledger
 * that is off by a few paise a month until someone investigates (ADR-004).
 *
 * So arithmetic lives here, every function takes and returns strings or
 * Decimals, and `.toNumber()` is banned by a lint rule everywhere else.
 *
 * `decimal.js` is a direct dependency rather than Prisma's bundled copy, so
 * this module has no dependency on the ORM and can be used from anywhere.
 */

/**
 * ROUND_HALF_UP, matching BR-708. decimal.js defaults to ROUND_HALF_UP
 * already, but relying on a library default for a legal requirement is how
 * a dependency upgrade silently changes invoice totals.
 */
Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 34 });

/** Scale for currency amounts. Matches the NUMERIC(14,2) columns. */
export const MONEY_SCALE = 2;

/** Scale for fuel quantities - litres to the millilitre (docs/08 §3.4). */
export const QUANTITY_SCALE = 3;

/**
 * Coerce to Decimal.
 *
 * Rejects JS numbers outright. A number reaching here means someone already
 * lost precision upstream, and silently accepting it would hide exactly the
 * defect this module exists to prevent.
 *
 * @param {string|Decimal|{toString: () => string}} value
 * @returns {Decimal}
 */
export const toDecimal = (value) => {
  if (value instanceof Decimal) return value;

  if (typeof value === 'number') {
    throw new TypeError(
      `Money and quantities must not be JS numbers (received ${value}). ` +
        'Pass a string or a Decimal - a number has already lost precision.'
    );
  }

  if (value === null || value === undefined) {
    throw new TypeError('Money value is null or undefined');
  }

  // Prisma Decimal, or a plain string.
  return new Decimal(value.toString());
};

export const add = (a, b) => toDecimal(a).plus(toDecimal(b));
export const subtract = (a, b) => toDecimal(a).minus(toDecimal(b));
export const multiply = (a, b) => toDecimal(a).times(toDecimal(b));
export const divide = (a, b) => toDecimal(a).dividedBy(toDecimal(b));

/** Sum a list. Empty list is zero, not an error - an empty invoice is valid. */
export const sum = (values) =>
  values.reduce((total, value) => total.plus(toDecimal(value)), new Decimal(0));

/**
 * Round half-up to a given scale.
 *
 * BR-708 requires rounding at LINE level only. Rounding intermediate values
 * inside a line, then rounding the line again, compounds error and is how a
 * total stops equalling the sum of its parts.
 */
export const round = (value, scale = MONEY_SCALE) =>
  toDecimal(value).toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);

export const roundMoney = (value) => round(value, MONEY_SCALE);
export const roundQuantity = (value) => round(value, QUANTITY_SCALE);

/**
 * Serialise for JSON, at a fixed scale.
 *
 * ALWAYS a string (ADR-015, control M7). A JSON number is parsed as a double
 * by every client including Flutter, which would undo the exactness at the API
 * boundary after all the care taken to preserve it in the database.
 */
export const toMoneyString = (value) => round(value, MONEY_SCALE).toFixed(MONEY_SCALE);
export const toQuantityString = (value) => round(value, QUANTITY_SCALE).toFixed(QUANTITY_SCALE);

export const isPositive = (value) => toDecimal(value).greaterThan(0);
export const isZero = (value) => toDecimal(value).isZero();
export const isNegative = (value) => toDecimal(value).lessThan(0);
export const compare = (a, b) => toDecimal(a).comparedTo(toDecimal(b));
export const equals = (a, b) => toDecimal(a).equals(toDecimal(b));
export const greaterThan = (a, b) => toDecimal(a).greaterThan(toDecimal(b));
export const greaterThanOrEqual = (a, b) => toDecimal(a).greaterThanOrEqualTo(toDecimal(b));
export const lessThan = (a, b) => toDecimal(a).lessThan(toDecimal(b));
export const max = (a, b) => (greaterThan(a, b) ? toDecimal(a) : toDecimal(b));
export const min = (a, b) => (lessThan(a, b) ? toDecimal(a) : toDecimal(b));

export const ZERO = new Decimal(0);
export const ONE = new Decimal(1);
export const HUNDRED = new Decimal(100);

/**
 * Percentage OF an amount: `amount * (percent / 100)`.
 *
 * Used for tax-EXCLUSIVE lines, where tax is added on top of a taxable base -
 * the delivery charge (BR-705).
 */
export const percentOf = (amount, percent) => multiply(amount, divide(toDecimal(percent), HUNDRED));

/**
 * Extract the tax already contained in a tax-INCLUSIVE amount.
 *
 *   taxable = gross / (1 + percent/100)
 *   tax     = gross - taxable
 *
 * This is the diesel case (BR-705): the pump rate a customer sees already
 * contains VAT, so tax is DERIVED FROM it rather than added to it. Computing
 * it as `gross * percent` instead - the intuitive mistake - overstates the tax
 * and understates revenue on every single line.
 *
 * @returns {{ taxable: Decimal, tax: Decimal }}
 */
export const extractInclusiveTax = (gross, percent) => {
  const grossAmount = toDecimal(gross);
  const divisor = ONE.plus(divide(toDecimal(percent), HUNDRED));
  const taxable = grossAmount.dividedBy(divisor);

  return { taxable, tax: grossAmount.minus(taxable) };
};

export { Decimal };
