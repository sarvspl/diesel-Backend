import { z } from 'zod';

/** Request validation for the customer module. */

/**
 * Reused from identity's rules: E.164, India-only in Phase 1 (BR-115).
 * Duplicated as a local constant rather than imported so the customer module
 * does not reach into another module's internals for a validation detail.
 */
const indianPhone = z
  .string()
  .trim()
  .regex(/^\+91[6-9]\d{9}$/, 'Must be a valid Indian mobile number, e.g. +919876543210');

/**
 * Coordinates arrive as STRINGS and stay strings all the way to the Decimal
 * column. A JSON number is parsed as a double by every client, and rounding a
 * coordinate shifts a delivery point by metres - which is exactly the error
 * geofence deviation checks are meant to detect (docs/10 §5.3).
 */
const latitude = z
  .string()
  .trim()
  .regex(/^-?\d{1,2}(\.\d{1,7})?$/, 'Latitude must be a decimal string')
  .refine((value) => Math.abs(Number(value)) <= 90, 'Latitude must be between -90 and 90');

const longitude = z
  .string()
  .trim()
  .regex(/^-?\d{1,3}(\.\d{1,7})?$/, 'Longitude must be a decimal string')
  .refine((value) => Math.abs(Number(value)) <= 180, 'Longitude must be between -180 and 180');

const pincode = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Must be a 6-digit Indian PIN code');

const notificationPreferences = {
  notifyByPush: z.boolean().optional(),
  notifyBySms: z.boolean().optional(),
  notifyByEmail: z.boolean().optional(),
};

export const registerCustomerSchema = {
  body: z.object({
    fullName: z.string().trim().min(1).max(120).optional(),
    preferredLanguage: z.string().trim().max(12).default('en'),
    emergencyContactName: z.string().trim().max(120).optional(),
    emergencyContactPhone: indianPhone.optional(),
    /**
     * Marketing consent defaults to FALSE. Opt-in must be an explicit act -
     * a pre-ticked box is not consent under the DPDP Act (BR-107, BR-1405).
     */
    marketingOptIn: z.boolean().default(false),
    ...notificationPreferences,
  }),
};

export const updateCustomerSchema = {
  body: z
    .object({
      fullName: z.string().trim().min(1).max(120).optional(),
      preferredLanguage: z.string().trim().max(12).optional(),
      /** Storage key, never bytes. Uploads go direct to storage (docs/08 §12.4). */
      profileImageKey: z.string().trim().max(512).nullable().optional(),
      emergencyContactName: z.string().trim().max(120).nullable().optional(),
      emergencyContactPhone: indianPhone.nullable().optional(),
      marketingOptIn: z.boolean().optional(),
      ...notificationPreferences,
    })
    // An empty PATCH is a client bug. Accepting it silently returns an
    // unchanged resource and hides the mistake.
    .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update'),
};

/**
 * Phone and email are absent from both schemas on purpose. They are identity,
 * not profile: changing a phone number requires OTP verification of the old and
 * new numbers (BR-G3) and belongs to the identity module.
 */

const addressFields = {
  nickname: z.string().trim().max(80).optional(),
  line1: z.string().trim().min(1).max(255),
  line2: z.string().trim().max(255).optional(),
  landmark: z.string().trim().max(255).optional(),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(1).max(120),
  pincode,
  latitude,
  longitude,
  googlePlaceId: z.string().trim().max(255).optional(),
  deliveryInstructions: z.string().trim().max(500).optional(),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: indianPhone.optional(),
  isDefault: z.boolean().optional(),
};

export const createAddressSchema = {
  body: z.object(addressFields),
};

export const updateAddressSchema = {
  params: z.object({ id: z.string().uuid('Address id must be a UUID') }),
  body: z
    .object({
      ...Object.fromEntries(
        Object.entries(addressFields).map(([key, schema]) => [key, schema.optional()])
      ),
    })
    .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update')
    // Latitude and longitude are a pair. Accepting one alone would place the
    // address at a coordinate the caller never intended.
    .refine(
      (body) => (body.latitude === undefined) === (body.longitude === undefined),
      'Latitude and longitude must be provided together'
    ),
};

export const addressIdSchema = {
  params: z.object({ id: z.string().uuid('Address id must be a UUID') }),
};
