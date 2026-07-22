/**
 * JavaScript mirrors of the pricing Prisma enums.
 *
 * Same reasoning as the identity, corporate and fleet mirrors: without a
 * compiler, a bare string literal that drifts from the schema fails at runtime
 * on whichever branch uses it. The enum-parity test asserts these match.
 */

export const FUEL_UNIT = Object.freeze({
  LITRE: 'LITRE',
  KILOGRAM: 'KILOGRAM',
});

export const CATALOG_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
});

export const PRICE_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  ACTIVE: 'ACTIVE',
  SUPERSEDED: 'SUPERSEDED',
  CANCELLED: 'CANCELLED',
});

export const TAX_REGIME = Object.freeze({
  VAT_EXCISE: 'VAT_EXCISE',
  GST: 'GST',
  EXEMPT: 'EXEMPT',
});

export const TAX_CALCULATION_TYPE = Object.freeze({
  PERCENTAGE: 'PERCENTAGE',
  PER_UNIT: 'PER_UNIT',
});

export const TAX_APPLIES_TO = Object.freeze({
  FUEL: 'FUEL',
  DELIVERY: 'DELIVERY',
});

export const DELIVERY_CHARGE_TYPE = Object.freeze({
  FLAT: 'FLAT',
  DISTANCE_BASED: 'DISTANCE_BASED',
  ZONE_BASED: 'ZONE_BASED',
});

export const QUOTE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  CONSUMED: 'CONSUMED',
});

/**
 * Only FLAT has a calculator. DISTANCE_BASED and ZONE_BASED exist in the enum
 * so adding them is a branch plus data, not a migration - but accepting one
 * today would silently produce a zero charge (BR-608).
 */
export const IMPLEMENTED_DELIVERY_CHARGE_TYPES = Object.freeze([DELIVERY_CHARGE_TYPE.FLAT]);

/**
 * BR-607 fat-finger guard: a new price more than this far from the previous
 * one needs a second administrator. A misplaced decimal point is a 900% move,
 * so this catches it comfortably while allowing genuine daily revisions.
 */
export const PRICE_SANITY_BAND_PERCENT = 20;
