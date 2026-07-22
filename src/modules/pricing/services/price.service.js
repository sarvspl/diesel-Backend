import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { PRICE_SANITY_BAND_PERCENT, PRICE_STATUS } from '../../../shared/constants/pricing.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import {
  divide,
  greaterThan,
  isZero,
  multiply,
  round,
  subtract,
  toDecimal,
} from '../../../shared/utils/money.js';
import * as pricingRepository from '../repositories/pricing.repository.js';

const log = createLogger({ module: 'pricing.price' });

/**
 * Effective-dated pricing.
 *
 * APPEND-ONLY. A price is never edited: publishing a new rate inserts a row and
 * closes off the previous one. That is what makes "changing today's price must
 * never change yesterday's quote" true by CONSTRUCTION - a quote stores the
 * price row id it used, and that row's rate is immutable (BR-601, BR-606).
 *
 * Overlap is prevented by a PostgreSQL EXCLUDE constraint, not by the checks
 * below. The checks exist to produce a useful error; the constraint is what
 * makes a concurrent double-publish impossible (BR-602).
 */

const toPublicPrice = (price) => ({
  id: price.id,
  productId: price.productId,
  productCode: price.product?.code ?? undefined,
  city: price.city,
  pricePerUnit: price.pricePerUnit.toString(),
  effectiveFrom: price.effectiveFrom,
  effectiveUntil: price.effectiveUntil,
  status: price.status,
  approval: {
    required: price.requiresApproval,
    approvedByUserId: price.approvedByUserId,
    approvedAt: price.approvedAt,
    changePercent: price.changePercent === null ? null : price.changePercent.toString(),
  },
  supersededById: price.supersededById,
  notes: price.notes,
  createdByUserId: price.createdByUserId,
  createdAt: price.createdAt,
});

/**
 * How far a new rate moves from the current one, as a percentage.
 *
 * Returns null when there is no previous price - the first price for a product
 * has nothing to be out of band relative to.
 */
const changePercentFrom = (previousRate, newRate) => {
  if (previousRate === null) return null;

  const previous = toDecimal(previousRate);

  // Guard against dividing by zero if a product was ever priced at zero.
  if (isZero(previous)) return null;

  const delta = subtract(toDecimal(newRate), previous);

  return round(multiply(divide(delta, previous), toDecimal('100')), 4);
};

export const listPrices = async ({ productId, city, status, limit = 50, cursor }) => {
  const prices = await pricingRepository.listPrices({
    productId,
    city,
    status,
    limit: limit + 1,
    cursor,
  });

  const hasMore = prices.length > limit;
  const page = hasMore ? prices.slice(0, limit) : prices;

  return {
    prices: page.map(toPublicPrice),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

/**
 * Publish a new price version.
 *
 * BR-607 fat-finger guard: a rate more than ±20% from the current one is
 * accepted but parked as PENDING_APPROVAL rather than going live. A misplaced
 * decimal point is a 900% move, so this catches the mistake that actually
 * happens while leaving genuine daily revisions alone.
 *
 * Parked rather than rejected on purpose - a real 25% move during a fuel crisis
 * must be possible, it just should not be one person's typo away from live.
 */
export const publishPrice = async ({
  actorUserId,
  productId,
  city,
  pricePerUnit,
  effectiveFrom,
  notes,
}) => {
  const product = await pricingRepository.findProductById(productId);

  if (!product) {
    throw new NotFoundError('Product not found', { code: ERROR_CODES.PRODUCT_NOT_FOUND });
  }

  if (product.archivedAt !== null || product.status !== 'ACTIVE') {
    throw new ConflictError('That product is not active', {
      code: ERROR_CODES.PRODUCT_INACTIVE,
    });
  }

  const effectiveAt = effectiveFrom ?? new Date();

  /**
   * Backdating is refused. A price that starts before now would retroactively
   * change what past quotes were computed against - the exact thing the
   * append-only model exists to prevent. A one-minute tolerance absorbs clock
   * skew between the admin's browser and the server.
   */
  if (effectiveAt.getTime() < Date.now() - 60_000) {
    throw new BadRequestError(
      'A price cannot take effect in the past. Backdating would change what past quotes were priced at.',
      { code: ERROR_CODES.PRICE_EFFECTIVE_IN_PAST }
    );
  }

  const current = await pricingRepository.findActivePrice({ productId, city });
  const changePercent = changePercentFrom(current?.pricePerUnit ?? null, pricePerUnit);

  const outOfBand =
    changePercent !== null &&
    greaterThan(changePercent.abs(), toDecimal(String(PRICE_SANITY_BAND_PERCENT)));

  const price = await pricingRepository.publishPrice({
    data: {
      productId,
      city,
      pricePerUnit,
      effectiveFrom: effectiveAt,
      // An out-of-band price is parked; it must not close off the live one
      // until a second administrator approves it.
      status: outOfBand ? PRICE_STATUS.PENDING_APPROVAL : PRICE_STATUS.ACTIVE,
      requiresApproval: outOfBand,
      changePercent,
      notes: notes ?? null,
      createdByUserId: actorUserId,
    },
    previousPriceId: current?.id ?? null,
    activateNow: !outOfBand,
  });

  if (outOfBand) {
    log.warn(
      { priceId: price.id, productId, city, changePercent: changePercent.toString(), actorUserId },
      'price outside the sanity band - held for approval'
    );
  } else {
    log.info({ priceId: price.id, productId, city, actorUserId }, 'price published');
  }

  return {
    price: toPublicPrice(price),
    ...(outOfBand
      ? {
          warning: {
            code: ERROR_CODES.PRICE_OUT_OF_SANITY_BAND,
            message: `This is a ${changePercent.toString()}% change and needs a second administrator's approval before it takes effect.`,
            changePercent: changePercent.toString(),
            bandPercent: String(PRICE_SANITY_BAND_PERCENT),
          },
        }
      : {}),
  };
};

/**
 * Approve, activate or cancel a parked price.
 *
 * SEPARATION OF DUTIES: the approver must not be the author. One person able to
 * both set an out-of-band price and wave it through defeats the entire point of
 * the guard (docs/03 §4.4).
 */
export const updatePriceStatus = async ({ id, actorUserId, status, actorPermissions = [] }) => {
  const price = await pricingRepository.findPriceById(id);

  if (!price) throw new NotFoundError('Price not found');

  if (price.status === PRICE_STATUS.SUPERSEDED) {
    throw new ConflictError('A superseded price cannot be changed', {
      code: ERROR_CODES.PRICE_ALREADY_SUPERSEDED,
    });
  }

  if (status === PRICE_STATUS.ACTIVE) {
    if (price.status !== PRICE_STATUS.PENDING_APPROVAL && price.status !== PRICE_STATUS.DRAFT) {
      throw new ConflictError('Only a pending or draft price can be activated', {
        code: ERROR_CODES.PRICE_NOT_PENDING_APPROVAL,
      });
    }

    if (price.requiresApproval) {
      if (!actorPermissions.includes('price.approve')) {
        throw new ForbiddenError('Approving an out-of-band price needs the price.approve grant', {
          code: ERROR_CODES.INSUFFICIENT_PERMISSIONS,
        });
      }

      if (price.createdByUserId === actorUserId) {
        throw new ForbiddenError(
          'An out-of-band price must be approved by a different administrator',
          { code: ERROR_CODES.SELF_APPROVAL_FORBIDDEN }
        );
      }
    }

    // Close off whatever is live before this one goes live, or the EXCLUDE
    // constraint will reject the activation.
    const current = await pricingRepository.findActivePrice({
      productId: price.productId,
      city: price.city,
    });

    if (current && current.id !== price.id) {
      await pricingRepository.updatePriceStatus({
        id: current.id,
        status: PRICE_STATUS.SUPERSEDED,
        effectiveUntil: price.effectiveFrom,
      });
    }

    const activated = await pricingRepository.updatePriceStatus({
      id,
      status: PRICE_STATUS.ACTIVE,
      approvedByUserId: price.requiresApproval ? actorUserId : undefined,
    });

    log.warn({ priceId: id, actorUserId, wasOutOfBand: price.requiresApproval }, 'price activated');

    return toPublicPrice(activated);
  }

  const updated = await pricingRepository.updatePriceStatus({ id, status });

  log.info({ priceId: id, status, actorUserId }, 'price status changed');

  return toPublicPrice(updated);
};

export { toPublicPrice };
