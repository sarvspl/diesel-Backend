import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Data access for the pricing catalogue.
 *
 * One repository because products, prices, taxes and delivery rules form a
 * single configuration aggregate that the quote engine reads together in one
 * pass. Splitting them would mean four round trips to price one order.
 */

const PRODUCT_FIELDS = {
  id: true,
  code: true,
  name: true,
  description: true,
  unit: true,
  hsnCode: true,
  status: true,
  displayOrder: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
};

const PRICE_FIELDS = {
  id: true,
  productId: true,
  city: true,
  pricePerUnit: true,
  effectiveFrom: true,
  effectiveUntil: true,
  status: true,
  requiresApproval: true,
  approvedByUserId: true,
  approvedAt: true,
  changePercent: true,
  supersededById: true,
  notes: true,
  createdByUserId: true,
  createdAt: true,
};

const TAX_FIELDS = {
  id: true,
  name: true,
  code: true,
  regime: true,
  appliesTo: true,
  calculationType: true,
  rate: true,
  isInclusive: true,
  state: true,
  sacCode: true,
  sequence: true,
  effectiveFrom: true,
  effectiveUntil: true,
  status: true,
  createdAt: true,
  updatedAt: true,
};

const DELIVERY_FIELDS = {
  id: true,
  name: true,
  chargeType: true,
  city: true,
  pincode: true,
  flatCharge: true,
  minQuantity: true,
  maxQuantity: true,
  minimumOrderQuantity: true,
  freeAboveOrderValue: true,
  sacCode: true,
  priority: true,
  effectiveFrom: true,
  effectiveUntil: true,
  status: true,
  createdAt: true,
  updatedAt: true,
};

// --- Products --------------------------------------------------------------

export const listProducts = async ({ includeArchived = false } = {}) =>
  prisma.fuelProduct.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    select: PRODUCT_FIELDS,
    orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
  });

export const findProductById = async (id) =>
  prisma.fuelProduct.findUnique({ where: { id }, select: PRODUCT_FIELDS });

export const findProductByCode = async (code) =>
  prisma.fuelProduct.findUnique({ where: { code }, select: PRODUCT_FIELDS });

export const createProduct = async ({ data, actorUserId }) =>
  prisma.fuelProduct.create({
    data: { ...data, createdByUserId: actorUserId, updatedByUserId: actorUserId },
    select: PRODUCT_FIELDS,
  });

export const updateProduct = async ({ id, data, actorUserId }) =>
  prisma.fuelProduct.update({
    where: { id },
    data: { ...data, updatedByUserId: actorUserId },
    select: PRODUCT_FIELDS,
  });

// --- Prices ----------------------------------------------------------------

/**
 * The price in force for a product and city at an instant.
 *
 * The window is half-open: `effectiveFrom <= at < effectiveUntil`. A closed
 * upper bound would make the changeover instant belong to two versions, which
 * is exactly the ambiguity the EXCLUDE constraint forbids.
 */
export const findActivePrice = async ({ productId, city, at = new Date() }) =>
  prisma.fuelPrice.findFirst({
    where: {
      productId,
      city,
      status: 'ACTIVE',
      effectiveFrom: { lte: at },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }],
    },
    select: PRICE_FIELDS,
    orderBy: { effectiveFrom: 'desc' },
  });

export const findPriceById = async (id) =>
  prisma.fuelPrice.findUnique({ where: { id }, select: PRICE_FIELDS });

export const listPrices = async ({ productId, city, status, limit, cursor }) =>
  prisma.fuelPrice.findMany({
    where: {
      ...(productId ? { productId } : {}),
      ...(city ? { city } : {}),
      ...(status ? { status } : {}),
    },
    select: { ...PRICE_FIELDS, product: { select: { code: true, name: true } } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

/**
 * Publish a new price version.
 *
 * APPEND-ONLY. The previous version is not edited in the sense that matters -
 * its rate is never touched. It is closed off: `effectiveUntil` is set to the
 * new version's start and its status becomes SUPERSEDED, so the historical
 * rate and its window remain exactly as they were.
 *
 * One transaction, because a gap or an overlap between the two rows would make
 * some instant either unpriced or ambiguously priced. The database EXCLUDE
 * constraint is the backstop if this is ever got wrong.
 */
export const publishPrice = async ({ data, previousPriceId, activateNow }) =>
  prisma.$transaction(async (tx) => {
    if (previousPriceId && activateNow) {
      await tx.fuelPrice.update({
        where: { id: previousPriceId },
        data: { effectiveUntil: data.effectiveFrom, status: 'SUPERSEDED' },
      });
    }

    const created = await tx.fuelPrice.create({ data, select: PRICE_FIELDS });

    if (previousPriceId && activateNow) {
      await tx.fuelPrice.update({
        where: { id: previousPriceId },
        data: { supersededById: created.id },
      });
    }

    return created;
  });

/**
 * Transition a price's status.
 *
 * The only mutation a price row ever receives. `pricePerUnit`,
 * `effectiveFrom` and `createdByUserId` are deliberately absent from every
 * update path in this repository - the rate is immutable once written.
 */
export const updatePriceStatus = async ({ id, status, approvedByUserId, effectiveUntil }) =>
  prisma.fuelPrice.update({
    where: { id },
    data: {
      status,
      ...(approvedByUserId ? { approvedByUserId, approvedAt: new Date() } : {}),
      ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    },
    select: PRICE_FIELDS,
  });

// --- Tax rules -------------------------------------------------------------

/**
 * Tax rules in force at an instant.
 *
 * `state` null means the rule applies everywhere; a value scopes it. Both are
 * returned and the service picks, because a state-specific rule should win
 * over a national default without a second query.
 */
export const findActiveTaxRules = async ({ at = new Date(), state = null } = {}) =>
  prisma.taxRule.findMany({
    where: {
      status: 'ACTIVE',
      effectiveFrom: { lte: at },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }],
      ...(state ? { OR: [{ state: null }, { state }] } : {}),
    },
    select: TAX_FIELDS,
    orderBy: [{ appliesTo: 'asc' }, { sequence: 'asc' }],
  });

export const listTaxRules = async ({ appliesTo, status } = {}) =>
  prisma.taxRule.findMany({
    where: { ...(appliesTo ? { appliesTo } : {}), ...(status ? { status } : {}) },
    select: TAX_FIELDS,
    orderBy: [{ appliesTo: 'asc' }, { sequence: 'asc' }, { effectiveFrom: 'desc' }],
  });

export const findTaxRuleById = async (id) =>
  prisma.taxRule.findUnique({ where: { id }, select: TAX_FIELDS });

export const createTaxRule = async ({ data, actorUserId }) =>
  prisma.taxRule.create({
    data: { ...data, createdByUserId: actorUserId, updatedByUserId: actorUserId },
    select: TAX_FIELDS,
  });

export const updateTaxRule = async ({ id, data, actorUserId }) =>
  prisma.taxRule.update({
    where: { id },
    data: { ...data, updatedByUserId: actorUserId },
    select: TAX_FIELDS,
  });

// --- Delivery charges ------------------------------------------------------

/**
 * The delivery rule that covers a quantity in a city.
 *
 * City-specific rules are preferred over the global default, then lower
 * `priority` wins - so precedence is explicit rather than dependent on
 * insertion order (BR-608, and the same determinism BR-503 requires of zones).
 */
/**
 * The rule that governs one order.
 *
 * MOST SPECIFIC WINS: pincode, then city, then the unscoped fallback.
 *
 * Pincode is checked first because it is the only one of the three that is
 * reliable. The `city` on an address is whatever the customer's phone geocoded
 * — the same site can come back "Chakpachuria", "New Town" or "Kolkata" — so a
 * rule scoped to a city an operator typed matches only by luck. Six digits do
 * not have that problem.
 *
 * Within a tier the ordering is already applied by the query: lowest priority
 * number first, newest as the tie-break.
 */
export const findApplicableDeliveryRule = async ({ city, pincode, quantity, at = new Date() }) => {
  const candidates = await prisma.deliveryChargeRule.findMany({
    where: {
      status: 'ACTIVE',
      effectiveFrom: { lte: at },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }],
      minQuantity: { lte: quantity },
      AND: [{ OR: [{ maxQuantity: null }, { maxQuantity: { gte: quantity } }] }],
    },
    select: DELIVERY_FIELDS,
    orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
  });

  return (
    (pincode ? candidates.find((rule) => rule.pincode === pincode) : undefined) ??
    candidates.find((rule) => rule.pincode === null && rule.city === city) ??
    candidates.find((rule) => rule.pincode === null && rule.city === null) ??
    null
  );
};

export const listDeliveryRules = async ({ city, pincode, status } = {}) =>
  prisma.deliveryChargeRule.findMany({
    where: {
      ...(city ? { city } : {}),
      ...(pincode ? { pincode } : {}),
      ...(status ? { status } : {}),
    },
    select: DELIVERY_FIELDS,
    orderBy: [{ priority: 'asc' }, { minQuantity: 'asc' }],
  });

export const createDeliveryRule = async ({ data, actorUserId }) =>
  prisma.deliveryChargeRule.create({
    data: { ...data, createdByUserId: actorUserId, updatedByUserId: actorUserId },
    select: DELIVERY_FIELDS,
  });

// --- Quotes ----------------------------------------------------------------

const QUOTE_FIELDS = {
  id: true,
  userId: true,
  addressId: true,
  productId: true,
  priceId: true,
  quantity: true,
  fuelAmount: true,
  deliveryAmount: true,
  taxAmount: true,
  totalAmount: true,
  breakdown: true,
  city: true,
  state: true,
  status: true,
  expiresAt: true,
  createdAt: true,
};

export const createQuote = async (data) => prisma.quote.create({ data, select: QUOTE_FIELDS });

/**
 * Scoped by user: a quote belonging to someone else is indistinguishable from
 * one that does not exist, so there is no query that could return another
 * customer's pricing (BR-225).
 */
export const findQuoteForUser = async ({ id, userId }) =>
  prisma.quote.findFirst({ where: { id, userId }, select: QUOTE_FIELDS });

/** Mark lapsed quotes EXPIRED. Intended for a scheduled sweep. */
export const expireLapsedQuotes = async (before = new Date()) => {
  const { count } = await prisma.quote.updateMany({
    where: { status: 'ACTIVE', expiresAt: { lt: before } },
    data: { status: 'EXPIRED' },
  });

  return count;
};
