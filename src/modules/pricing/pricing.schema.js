import { z } from 'zod';

import {
  CATALOG_STATUS,
  DELIVERY_CHARGE_TYPE,
  FUEL_UNIT,
  PRICE_STATUS,
  TAX_APPLIES_TO,
  TAX_CALCULATION_TYPE,
  TAX_REGIME,
} from '../../shared/constants/pricing.js';

/** Request validation for the pricing & catalog module. */

const uuid = (label) => z.string().uuid(`${label} must be a UUID`);

/**
 * Money and quantities are STRINGS end to end (ADR-015, control M7).
 *
 * A JSON number is parsed as a double by every client, so accepting one here
 * would lose precision before validation even ran - and this is the module
 * where that precision is the entire point.
 */
const decimalString = ({ label, maxIntegerDigits, scale, allowZero = false, max }) =>
  z
    .string()
    .trim()
    .regex(
      new RegExp(`^\\d{1,${maxIntegerDigits}}(\\.\\d{1,${scale}})?$`),
      `${label} must be a positive decimal string with at most ${scale} decimal places`
    )
    .refine((value) => (allowZero ? Number(value) >= 0 : Number(value) > 0), {
      message: allowZero ? `${label} cannot be negative` : `${label} must be greater than zero`,
    })
    .refine((value) => max === undefined || Number(value) <= max, {
      message: `${label} must not exceed ${max}`,
    });

const money = (label, options = {}) =>
  decimalString({ label, maxIntegerDigits: 12, scale: 2, max: 10_000_000, ...options });

const quantity = (label, options = {}) =>
  decimalString({ label, maxIntegerDigits: 9, scale: 3, max: 100_000, ...options });

/** A price per unit carries 4 decimals: fuel is quoted to fractions of a paisa. */
const pricePerUnit = decimalString({
  label: 'Price per unit',
  maxIntegerDigits: 10,
  scale: 4,
  max: 100_000,
});

/**
 * A tax rate. Percentages are capped at 100; a per-unit duty is an amount and
 * is bounded more loosely. Both are validated as positive decimals - a negative
 * tax is a discount, and discounts are the promotions module's problem.
 */
const taxRate = decimalString({
  label: 'Rate',
  maxIntegerDigits: 8,
  scale: 4,
  allowZero: true,
  max: 100_000,
});

const isoTimestamp = z
  .string()
  .datetime({ message: 'Must be an ISO 8601 timestamp' })
  .transform((value) => new Date(value));

// --- Products --------------------------------------------------------------

export const listProductsSchema = {
  query: z.object({
    includeArchived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  }),
};

export const createProductSchema = {
  body: z.object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .min(2)
      .max(32)
      .regex(/^[A-Z0-9_]+$/, 'Code may contain only capitals, digits and underscores'),
    name: z.string().trim().min(2).max(120),
    description: z.string().trim().max(1000).optional(),
    unit: z.enum(Object.values(FUEL_UNIT)).default(FUEL_UNIT.LITRE),
    /** Required on every goods line of an invoice (BR-706). */
    hsnCode: z.string().trim().max(16).optional(),
    displayOrder: z.coerce.number().int().min(0).max(9999).default(0),
  }),
};

export const updateProductSchema = {
  params: z.object({ id: uuid('Product id') }),
  body: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      unit: z.enum(Object.values(FUEL_UNIT)).optional(),
      hsnCode: z.string().trim().max(16).nullable().optional(),
      status: z.enum(Object.values(CATALOG_STATUS)).optional(),
      displayOrder: z.coerce.number().int().min(0).max(9999).optional(),
      archive: z.boolean().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update'),
};

/**
 * `code` is deliberately absent from the update schema. It is the stable
 * machine identifier that seeds and reports reference; renaming it would
 * silently break them.
 */

// --- Prices ----------------------------------------------------------------

export const listPricesSchema = {
  query: z.object({
    productId: z.string().uuid().optional(),
    city: z.string().trim().max(120).optional(),
    status: z.enum(Object.values(PRICE_STATUS)).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  }),
};

export const createPriceSchema = {
  body: z.object({
    productId: uuid('Product id'),
    /** BR-601: prices are per product per city. */
    city: z.string().trim().min(1).max(120),
    /** The tax-INCLUSIVE retail rate (BR-705). */
    pricePerUnit,
    /**
     * Defaults to now. Cannot be backdated - the service refuses a start in
     * the past, because that would retroactively change what past quotes were
     * priced against.
     */
    effectiveFrom: isoTimestamp.optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
};

export const updatePriceStatusSchema = {
  params: z.object({ id: uuid('Price id') }),
  body: z.object({
    /**
     * SUPERSEDED is absent: it is set by publishing a newer version, never
     * chosen directly, or the price timeline would develop gaps.
     */
    status: z.enum([PRICE_STATUS.ACTIVE, PRICE_STATUS.CANCELLED, PRICE_STATUS.DRAFT]),
  }),
};

// --- Tax rules -------------------------------------------------------------

export const listTaxesSchema = {
  query: z.object({
    appliesTo: z.enum(Object.values(TAX_APPLIES_TO)).optional(),
    status: z.enum(Object.values(CATALOG_STATUS)).optional(),
  }),
};

export const createTaxSchema = {
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      code: z
        .string()
        .trim()
        .toUpperCase()
        .min(2)
        .max(64)
        .regex(/^[A-Z0-9_]+$/, 'Code may contain only capitals, digits and underscores'),
      /**
       * These three are REQUIRED, not defaulted. A rule that does not say which
       * regime it belongs to, which line it attaches to, and whether it is
       * already inside the price cannot be applied correctly - and getting
       * inclusivity backwards overstates tax on every invoice (BR-703 - BR-705).
       */
      regime: z.enum(Object.values(TAX_REGIME)),
      appliesTo: z.enum(Object.values(TAX_APPLIES_TO)),
      isInclusive: z.boolean(),
      calculationType: z
        .enum(Object.values(TAX_CALCULATION_TYPE))
        .default(TAX_CALCULATION_TYPE.PERCENTAGE),
      rate: taxRate,
      state: z.string().trim().max(120).optional(),
      sacCode: z.string().trim().max(16).optional(),
      sequence: z.coerce.number().int().min(0).max(100).default(0),
      effectiveFrom: isoTimestamp,
      effectiveUntil: isoTimestamp.optional(),
    })
    .refine(
      (body) =>
        body.calculationType !== TAX_CALCULATION_TYPE.PERCENTAGE || Number(body.rate) <= 100,
      'A percentage rate cannot exceed 100'
    )
    .refine(
      (body) => !body.effectiveUntil || body.effectiveUntil > body.effectiveFrom,
      'effectiveUntil must be after effectiveFrom'
    ),
};

export const updateTaxSchema = {
  params: z.object({ id: uuid('Tax rule id') }),
  body: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      rate: taxRate.optional(),
      isInclusive: z.boolean().optional(),
      state: z.string().trim().max(120).nullable().optional(),
      sacCode: z.string().trim().max(16).nullable().optional(),
      sequence: z.coerce.number().int().min(0).max(100).optional(),
      effectiveUntil: isoTimestamp.nullable().optional(),
      status: z.enum(Object.values(CATALOG_STATUS)).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update'),
};

/**
 * `regime` and `appliesTo` cannot be changed. Retargeting an existing rule
 * would silently reinterpret every historical invoice that referenced it;
 * end it and create a replacement instead.
 */

// --- Delivery charges ------------------------------------------------------

export const listDeliveryChargesSchema = {
  query: z.object({
    city: z.string().trim().max(120).optional(),
    status: z.enum(Object.values(CATALOG_STATUS)).optional(),
  }),
};

export const createDeliveryChargeSchema = {
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      /** Only FLAT is implemented; the service refuses the others loudly. */
      chargeType: z.enum(Object.values(DELIVERY_CHARGE_TYPE)).default(DELIVERY_CHARGE_TYPE.FLAT),
      /** Null/absent means the rule is the global default. */
      city: z.string().trim().max(120).optional(),
      /** Tax-EXCLUSIVE: GST is added on top (BR-702). */
      flatCharge: money('Flat charge', { allowZero: true }),
      minQuantity: quantity('Minimum quantity', { allowZero: true }).default('0'),
      maxQuantity: quantity('Maximum quantity').optional(),
      minimumOrderQuantity: quantity('Minimum order quantity').optional(),
      freeAboveOrderValue: money('Free-above order value').optional(),
      sacCode: z.string().trim().max(16).optional(),
      priority: z.coerce.number().int().min(0).max(1000).default(100),
      effectiveFrom: isoTimestamp,
      effectiveUntil: isoTimestamp.optional(),
    })
    .refine(
      (body) => !body.maxQuantity || Number(body.maxQuantity) > Number(body.minQuantity),
      'maxQuantity must be greater than minQuantity'
    )
    .refine(
      (body) => !body.effectiveUntil || body.effectiveUntil > body.effectiveFrom,
      'effectiveUntil must be after effectiveFrom'
    ),
};

// --- Quotes ----------------------------------------------------------------

export const createQuoteSchema = {
  body: z.object({
    addressId: uuid('Address id'),
    productId: uuid('Product id'),
    /**
     * No price field, by design. BR-603: the price is computed server-side and
     * a client-supplied one is never trusted.
     */
    quantity: quantity('Quantity'),
  }),
};

export const quoteIdSchema = {
  params: z.object({ id: uuid('Quote id') }),
};
