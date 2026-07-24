import { env } from '../../../config/env.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import {
  IMPLEMENTED_DELIVERY_CHARGE_TYPES,
  QUOTE_STATUS,
} from '../../../shared/constants/pricing.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import {
  greaterThanOrEqual,
  lessThan,
  multiply,
  toDecimal,
  toMoneyString,
  toQuantityString,
  ZERO,
} from '../../../shared/utils/money.js';
import * as addressRepository from '../../customer/repositories/address.repository.js';
import * as pricingRepository from '../repositories/pricing.repository.js';

import { assertBreakdownBalances, calculateQuoteBreakdown } from './tax-engine.service.js';

const log = createLogger({ module: 'pricing.quote' });

/**
 * The quote engine.
 *
 * A quote is a READ-ONLY calculation plus a time-limited price lock. It creates
 * no order, reserves no fuel and moves no money.
 *
 * Why it exists at all (ADR-010): it makes the price lock explicit and
 * auditable, and it makes it structurally impossible for a client to submit a
 * price the server did not compute (BR-603). The stored `priceId` is the
 * version an order will carry forward (BR-606).
 */

/**
 * Resolve the delivery charge for this order.
 *
 * Returns the NET (tax-exclusive) charge - GST is added by the tax engine
 * (BR-702, BR-705). Adding tax here as well would double-count it.
 */
const resolveDeliveryCharge = ({ rule, quantity, fuelAmount }) => {
  if (!rule) {
    throw new ConflictError('No delivery charge rule covers this order', {
      code: ERROR_CODES.NO_DELIVERY_CHARGE_RULE,
    });
  }

  if (!IMPLEMENTED_DELIVERY_CHARGE_TYPES.includes(rule.chargeType)) {
    // Refusing loudly rather than falling through to zero: a distance-based
    // rule reaching this code would silently make delivery free.
    throw new ConflictError(
      `Delivery charge type ${rule.chargeType} is configured but not implemented yet`,
      { code: ERROR_CODES.DELIVERY_CHARGE_TYPE_UNSUPPORTED }
    );
  }

  if (rule.minimumOrderQuantity && lessThan(quantity, rule.minimumOrderQuantity)) {
    throw new BadRequestError(
      `The minimum order for delivery is ${toQuantityString(rule.minimumOrderQuantity)}.`,
      {
        code: ERROR_CODES.BELOW_MINIMUM_ORDER_QUANTITY,
        details: { minimumOrderQuantity: toQuantityString(rule.minimumOrderQuantity) },
      }
    );
  }

  // Free above a threshold, measured against the FUEL amount - the delivery
  // charge cannot be part of the test that decides whether to charge it.
  if (rule.freeAboveOrderValue && greaterThanOrEqual(fuelAmount, rule.freeAboveOrderValue)) {
    return { charge: ZERO, waived: true, rule };
  }

  return { charge: toDecimal(rule.flatCharge), waived: false, rule };
};

/**
 * Generate a quote.
 *
 * The address is loaded through the CUSTOMER module's repository, which scopes
 * every query to the caller - so a quote cannot be generated against someone
 * else's address regardless of the id supplied (BR-225).
 */
export const createQuote = async ({ userId, addressId, productId, quantity }) => {
  const address = await addressRepository.findForUser({ id: addressId, userId });

  if (!address) {
    // 404 rather than 403: a 403 would confirm the address id is real.
    throw new NotFoundError('Address not found');
  }

  const product = await pricingRepository.findProductById(productId);

  if (!product || product.archivedAt !== null) {
    throw new NotFoundError('Product not found', { code: ERROR_CODES.PRODUCT_NOT_FOUND });
  }

  if (product.status !== 'ACTIVE') {
    throw new ConflictError('That product is not currently available', {
      code: ERROR_CODES.PRODUCT_INACTIVE,
    });
  }

  const price = await pricingRepository.findActivePrice({
    productId,
    city: address.city,
    // Preferred over the city, which is only ever as good as the geocoder that
    // filled it in on the customer's phone.
    pincode: address.pincode,
  });

  if (!price) {
    // Names BOTH scopes an operator could have published under, because the
    // message is the whole diagnosis: someone reading it needs to know which
    // values were looked for, and a city alone sent people publishing for
    // "Kolkata" when the address said "Chakpachuria".
    throw new ConflictError(
      `No price is configured for ${product.name} at PIN ${address.pincode} (${address.city})`,
      {
        code: ERROR_CODES.NO_ACTIVE_PRICE,
        details: { productCode: product.code, city: address.city, pincode: address.pincode },
      }
    );
  }

  const qty = toDecimal(quantity);
  const fuelAmount = multiply(qty, price.pricePerUnit);

  const deliveryRule = await pricingRepository.findApplicableDeliveryRule({
    city: address.city,
    // Preferred over the city when a rule is scoped to it: the pincode is the
    // one part of an address that means the same thing on every device.
    pincode: address.pincode,
    quantity: qty,
  });

  const delivery = resolveDeliveryCharge({ rule: deliveryRule, quantity: qty, fuelAmount });

  // State-scoped rules win over national defaults; the repository returns both
  // and the engine applies them in sequence order.
  const taxRules = await pricingRepository.findActiveTaxRules({ state: address.state });

  const breakdown = calculateQuoteBreakdown({
    product,
    price,
    quantity: qty,
    deliveryCharge: delivery.charge,
    deliverySacCode: delivery.rule.sacCode,
    taxRules: taxRules.map((rule) => ({ ...rule, rate: rule.rate.toString() })),
  });

  breakdown.deliveryWaived = delivery.waived;
  breakdown.deliveryRuleId = delivery.rule.id;

  /**
   * Control M5 / INV-09: the total must equal the sum of its lines EXACTLY.
   * Asserted rather than assumed - a rounding regression produces invoices
   * that are wrong by a few paise and that nobody notices until a tax filing.
   */
  try {
    assertBreakdownBalances(breakdown);
  } catch (error) {
    log.error({ err: error, productId, addressId }, 'quote breakdown failed to balance');
    throw new ConflictError('The price breakdown could not be computed reliably', {
      code: ERROR_CODES.BREAKDOWN_DOES_NOT_BALANCE,
    });
  }

  const expiresAt = new Date(Date.now() + env.QUOTE_TTL_SECONDS * 1_000);

  const quote = await pricingRepository.createQuote({
    userId,
    addressId,
    productId,
    // The exact price VERSION. This is what an order carries forward, and what
    // makes a later price change unable to alter this quote (BR-606).
    priceId: price.id,
    quantity: qty.toFixed(3),
    fuelAmount: breakdown.totals.fuelAmount,
    deliveryAmount: breakdown.totals.deliveryAmount,
    taxAmount: breakdown.totals.taxAmount,
    totalAmount: breakdown.totals.grandTotal,
    breakdown,
    city: address.city,
    state: address.state,
    expiresAt,
  });

  log.info(
    { quoteId: quote.id, userId, productId, priceId: price.id, total: breakdown.totals.grandTotal },
    'quote generated'
  );

  return toPublicQuote(quote);
};

/**
 * Customer-facing quote shape.
 *
 * Exposes the breakdown of THIS quote and nothing else. Price history, the
 * sanity band, who authored a rate and every other rule the calculation drew on
 * stay internal - a customer sees what they are being charged and why, not how
 * the platform prices.
 */
const toPublicQuote = (quote) => {
  const expired = quote.status !== QUOTE_STATUS.ACTIVE || quote.expiresAt <= new Date();

  return {
    id: quote.id,
    productId: quote.productId,
    addressId: quote.addressId,
    quantity: toQuantityString(quote.quantity),
    currency: 'INR',
    fuelAmount: toMoneyString(quote.fuelAmount),
    deliveryAmount: toMoneyString(quote.deliveryAmount),
    taxAmount: toMoneyString(quote.taxAmount),
    totalAmount: toMoneyString(quote.totalAmount),
    lines: quote.breakdown.lines,
    /**
     * The price version, by id and rate only. Deliberately NOT the history:
     * "quotes must never expose internal pricing history".
     */
    priceVersion: {
      priceId: quote.breakdown.priceVersion.priceId,
      pricePerUnit: quote.breakdown.priceVersion.pricePerUnit,
    },
    deliveryWaived: quote.breakdown.deliveryWaived ?? false,
    expiresAt: quote.expiresAt,
    isExpired: expired,
    status: expired && quote.status === QUOTE_STATUS.ACTIVE ? QUOTE_STATUS.EXPIRED : quote.status,
    createdAt: quote.createdAt,
  };
};

/**
 * Fetch a quote.
 *
 * An expired quote is RETURNED, marked expired, rather than hidden. BR-605
 * requires an explicit "the price changed from X to Y, confirm" step, and the
 * client cannot build that screen without the old quote to compare against.
 */
export const getQuote = async ({ id, userId }) => {
  const quote = await pricingRepository.findQuoteForUser({ id, userId });

  if (!quote) {
    throw new NotFoundError('Quote not found', { code: ERROR_CODES.QUOTE_NOT_FOUND });
  }

  return toPublicQuote(quote);
};

/** Mark lapsed quotes EXPIRED. Intended for a scheduled sweep; none exists yet. */
export const expireLapsedQuotes = async () => {
  const expired = await pricingRepository.expireLapsedQuotes();

  if (expired > 0) log.info({ expired }, 'lapsed quotes expired');

  return { expired };
};

export { toPublicQuote };
