import { z } from 'zod';

import { DRIVER_AVAILABILITY } from '../../shared/constants/fleet.js';

/** Request validation for the driver module. */

const uuid = (label) => z.string().uuid(`${label} must be a UUID`);

/**
 * A totaliser reading.
 *
 * A STRING, not a number. Meter readings carry leading zeros and up to three
 * decimals, and a JSON number is a double in every client — which is how
 * `018432.500` becomes `18432.5` and a delivery is short by half a litre.
 */
const totalizer = z
  .string()
  .trim()
  .regex(/^\d{1,14}(\.\d{1,3})?$/, 'Reading must be digits, with up to 3 decimal places');

/** Object storage KEY, never bytes. Uploads go direct via a pre-signed URL. */
const photoKey = z.string().trim().min(1).max(512);

const reasonCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(3)
  .max(64)
  .regex(/^[A-Z0-9_]+$/, 'Reason code may contain only capitals, digits and underscores');

const latitude = z.coerce.number().min(-90).max(90);
const longitude = z.coerce.number().min(-180).max(180);

export const availabilitySchema = {
  body: z.object({
    /**
     * ON_TRIP is excluded: it is a consequence of holding an order, not a
     * state a driver selects. The service rejects it too — this is the cheap
     * check, that is the authoritative one.
     */
    availability: z.enum([
      DRIVER_AVAILABILITY.ONLINE,
      DRIVER_AVAILABILITY.BREAK,
      DRIVER_AVAILABILITY.OFFLINE,
    ]),
  }),
};

export const startShiftSchema = {
  body: z.object({
    /**
     * The vehicle is named, but the DRIVER is not — it comes from the token.
     * A driver could otherwise start a shift in someone else's name.
     */
    vehicleId: uuid('Vehicle id'),
    openingTotalizer: totalizer,
    openingFuelQuantity: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,3})?$/)
      .optional(),
    photoKey: photoKey.optional(),
    notes: z.string().trim().max(500).optional(),
  }),
};

export const endShiftSchema = {
  body: z.object({
    closingTotalizer: totalizer,
    closingFuelQuantity: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,3})?$/)
      .optional(),
    photoKey: photoKey.optional(),
    /** BR-1022: declared cash is captured at shift close. */
    declaredCash: z
      .string()
      .trim()
      .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Cash must be an amount')
      .optional(),
    notes: z.string().trim().max(500).optional(),
  }),
};

export const listOrdersSchema = {
  query: z.object({
    scope: z.enum(['ACTIVE', 'COMPLETED']).default('ACTIVE'),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }),
};

export const orderIdSchema = {
  params: z.object({ id: uuid('Order id') }),
};

export const arriveSchema = {
  params: orderIdSchema.params,
  body: z.object({
    /** Optional: a basement has no fix. A missing position is not a failure. */
    latitude: latitude.optional(),
    longitude: longitude.optional(),
  }),
};

/**
 * Receiver verification.
 *
 * OTP is the primary path, and the FALLBACK is first-class rather than a
 * hidden escape hatch (BR-911). A dead customer phone must not strand a
 * tanker — "the fuel still has to be delivered".
 */
const receiverVerification = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('OTP'),
    /** 6 digits (BR-110). Verified server-side; never echoed back. */
    code: z
      .string()
      .trim()
      .regex(/^\d{4,10}$/, 'Code must be 4 to 10 digits'),
  }),
  z.object({
    method: z.literal('FALLBACK'),
    receiverName: z.string().trim().min(2).max(120),
    signatureKey: photoKey,
    sitePhotoKey: photoKey,
    reasonCode,
  }),
]);

export const startDispensingSchema = {
  params: orderIdSchema.params,
  body: z.object({
    openingTotalizer: totalizer,
    /**
     * BR-906 requires a photograph of every manually entered reading, but the
     * rule is enforced in the SERVICE rather than here, so the response
     * carries `METER_PHOTO_REQUIRED` instead of a generic validation failure.
     * The driver app branches on that code to reopen the camera; it cannot do
     * anything useful with "validation failed".
     */
    photoKey: photoKey.optional(),
    receiverVerification,
  }),
};

export const completeDeliverySchema = {
  params: orderIdSchema.params,
  body: z.object({
    /**
     * Generated ONCE by the app when the delivery is captured, and reused on
     * every retry (BR-914). Generating a fresh one per attempt produces exactly
     * the duplicate this mechanism exists to prevent.
     */
    clientDeliveryId: uuid('Client delivery id'),
    closingTotalizer: totalizer,
    /** Enforced in the service, for the same reason as the opening reading. */
    photoKey: photoKey.optional(),
    outcome: z.enum(['FULL', 'PARTIAL', 'FAILED']),
    /** Required for anything other than a clean full delivery. */
    reasonCode: reasonCode.optional(),
    temperatureC: z.coerce.number().min(-20).max(80).optional(),
    notes: z.string().trim().max(500).optional(),
  }).refine((value) => value.outcome === 'FULL' || Boolean(value.reasonCode), {
    message: 'A reason code is required for a partial or failed delivery',
    path: ['reasonCode'],
  }),
};
