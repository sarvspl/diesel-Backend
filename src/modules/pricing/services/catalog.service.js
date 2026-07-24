import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { CATALOG_STATUS } from '../../../shared/constants/pricing.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import { toMoneyString, toQuantityString } from '../../../shared/utils/money.js';
import * as pricingRepository from '../repositories/pricing.repository.js';

const log = createLogger({ module: 'pricing.catalog' });

/**
 * Fuel products, tax rules and delivery charge rules - the configuration the
 * quote engine reads.
 *
 * Nothing hardcodes a product, a tax rate or a charge. Adding petrol, changing
 * a VAT rate or introducing a free-delivery threshold is a row, not a release
 * ("Taxes are configuration, not constants").
 */

const toPublicProduct = (product) => ({
  id: product.id,
  code: product.code,
  name: product.name,
  description: product.description,
  unit: product.unit,
  hsnCode: product.hsnCode,
  status: product.status,
  displayOrder: product.displayOrder,
  isArchived: product.archivedAt !== null,
  createdAt: product.createdAt,
  updatedAt: product.updatedAt,
});

const toPublicTaxRule = (rule) => ({
  id: rule.id,
  name: rule.name,
  code: rule.code,
  regime: rule.regime,
  appliesTo: rule.appliesTo,
  calculationType: rule.calculationType,
  // A rate is not currency, but it is still a Decimal: rendering it through
  // Number would reintroduce the rounding this module exists to avoid.
  rate: rule.rate.toString(),
  isInclusive: rule.isInclusive,
  state: rule.state,
  sacCode: rule.sacCode,
  sequence: rule.sequence,
  effectiveFrom: rule.effectiveFrom,
  effectiveUntil: rule.effectiveUntil,
  status: rule.status,
});

const toPublicDeliveryRule = (rule) => ({
  id: rule.id,
  name: rule.name,
  chargeType: rule.chargeType,
  city: rule.city,
  pincode: rule.pincode,
  flatCharge: toMoneyString(rule.flatCharge),
  minQuantity: toQuantityString(rule.minQuantity),
  maxQuantity: rule.maxQuantity === null ? null : toQuantityString(rule.maxQuantity),
  minimumOrderQuantity:
    rule.minimumOrderQuantity === null ? null : toQuantityString(rule.minimumOrderQuantity),
  freeAboveOrderValue:
    rule.freeAboveOrderValue === null ? null : toMoneyString(rule.freeAboveOrderValue),
  sacCode: rule.sacCode,
  priority: rule.priority,
  effectiveFrom: rule.effectiveFrom,
  effectiveUntil: rule.effectiveUntil,
  status: rule.status,
});

// --- Products --------------------------------------------------------------

export const listProducts = async ({ includeArchived = false } = {}) => {
  const products = await pricingRepository.listProducts({ includeArchived });

  return { products: products.map(toPublicProduct) };
};

/**
 * What a CUSTOMER may order, in display order.
 *
 * Exists because the apps previously had no way to learn a product id at all:
 * the only listing was `GET /admin/pricing/products`, behind an admin
 * permission, so the customer app had to be COMPILED with the id baked in via
 * `--dart-define=FUEL_PRODUCT_ID`. An APK built for one environment then failed
 * against another, because product ids differ per database — which is exactly
 * how a build ended up telling customers "this build has no fuel product
 * configured" when they pressed Get price.
 *
 * ACTIVE only, and a deliberately thin projection: a customer has no business
 * knowing display order, audit columns or archive state.
 */
export const listOrderableProducts = async () => {
  const products = await pricingRepository.listProducts({ includeArchived: false });

  return {
    products: products
      .filter((product) => product.status === CATALOG_STATUS.ACTIVE)
      .map((product) => ({
        id: product.id,
        code: product.code,
        name: product.name,
        description: product.description,
        unit: product.unit,
      })),
  };
};

export const createProduct = async ({ actorUserId, ...input }) => {
  const existing = await pricingRepository.findProductByCode(input.code);

  if (existing) {
    throw new ConflictError('A product with that code already exists', {
      code: ERROR_CODES.PRODUCT_CODE_TAKEN,
    });
  }

  const product = await pricingRepository.createProduct({ data: input, actorUserId });

  log.info({ productId: product.id, code: product.code, actorUserId }, 'fuel product created');

  return toPublicProduct(product);
};

export const updateProduct = async ({ id, actorUserId, ...input }) => {
  const existing = await pricingRepository.findProductById(id);

  if (!existing) {
    throw new NotFoundError('Product not found', { code: ERROR_CODES.PRODUCT_NOT_FOUND });
  }

  const data = {};

  for (const field of ['name', 'description', 'unit', 'hsnCode', 'status', 'displayOrder']) {
    if (input[field] !== undefined) data[field] = input[field];
  }

  // Archiving is a status change with a timestamp, never a delete: prices and
  // quotes reference products permanently.
  if (input.archive === true && existing.archivedAt === null) {
    data.archivedAt = new Date();
    data.status = CATALOG_STATUS.INACTIVE;
  }

  if (input.archive === false && existing.archivedAt !== null) {
    data.archivedAt = null;
  }

  const product = await pricingRepository.updateProduct({ id, data, actorUserId });

  log.info({ productId: id, actorUserId }, 'fuel product updated');

  return toPublicProduct(product);
};

// --- Tax rules -------------------------------------------------------------

export const listTaxRules = async (filters) => {
  const rules = await pricingRepository.listTaxRules(filters);

  return { taxRules: rules.map(toPublicTaxRule) };
};

/**
 * Create a tax rule.
 *
 * The regime/appliesTo/isInclusive triple is what makes a legal invoice
 * possible, so it is required rather than defaulted - a rule that does not say
 * which line it attaches to, and whether it is already inside the price, is a
 * rule nobody can apply correctly (BR-703 - BR-705).
 */
export const createTaxRule = async ({ actorUserId, ...input }) => {
  const rule = await pricingRepository.createTaxRule({ data: input, actorUserId });

  log.info(
    { taxRuleId: rule.id, code: rule.code, regime: rule.regime, actorUserId },
    'tax rule created'
  );

  return toPublicTaxRule(rule);
};

export const updateTaxRule = async ({ id, actorUserId, ...input }) => {
  const existing = await pricingRepository.findTaxRuleById(id);

  if (!existing) throw new NotFoundError('Tax rule not found');

  const data = {};

  for (const field of [
    'name',
    'rate',
    'isInclusive',
    'state',
    'sacCode',
    'sequence',
    'effectiveUntil',
    'status',
  ]) {
    if (input[field] !== undefined) data[field] = input[field];
  }

  const rule = await pricingRepository.updateTaxRule({ id, data, actorUserId });

  // Logged at warn: a tax rate change alters every subsequent invoice and is
  // something an auditor will ask about.
  log.warn({ taxRuleId: id, actorUserId, changes: Object.keys(data) }, 'tax rule updated');

  return toPublicTaxRule(rule);
};

// --- Delivery charges ------------------------------------------------------

export const listDeliveryRules = async (filters) => {
  const rules = await pricingRepository.listDeliveryRules(filters);

  return { deliveryChargeRules: rules.map(toPublicDeliveryRule) };
};

export const createDeliveryRule = async ({ actorUserId, ...input }) => {
  const rule = await pricingRepository.createDeliveryRule({ data: input, actorUserId });

  log.info({ ruleId: rule.id, actorUserId }, 'delivery charge rule created');

  return toPublicDeliveryRule(rule);
};

export { toPublicProduct, toPublicTaxRule, toPublicDeliveryRule };
