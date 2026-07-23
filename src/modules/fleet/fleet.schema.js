import { z } from 'zod';

import {
  DRIVER_EMPLOYMENT_STATUS,
  METER_READING_TYPE,
  SHIFT_STATUS,
  VEHICLE_STATUS,
} from '../../shared/constants/fleet.js';

/** Request validation for the fleet module. */

const uuid = (label) => z.string().uuid(`${label} must be a UUID`);

const indianPhone = z
  .string()
  .trim()
  .regex(/^\+91[6-9]\d{9}$/, 'Must be a valid Indian mobile number, e.g. +919876543210');

/**
 * Litres, as a STRING all the way to the Decimal column.
 *
 * A JSON number is a double in every client; rounding a fuel quantity is how a
 * tanker ends up recorded as empty with 40 litres in it. Three decimal places
 * matches the column and the millilitre precision the docs specify.
 */
const litres = ({ min = 0, max = 100_000, allowZero = true } = {}) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,6}(\.\d{1,3})?$/, 'Quantity must be a positive decimal string, e.g. "1250.500"')
    .refine((value) => (allowZero ? Number(value) >= min : Number(value) > min), {
      message: allowZero ? `Must be at least ${min}` : 'Must be greater than zero',
    })
    .refine((value) => Number(value) <= max, { message: `Must not exceed ${max}` });

/**
 * A meter totaliser: wider than a tank quantity because it accumulates for the
 * life of the meter and never resets.
 */
const totalizer = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'Totaliser must be a positive decimal string');

/** ISO date (no time). Compliance expiries are dates, not instants. */
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD form')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Must be a real calendar date')
  .transform((value) => new Date(`${value}T00:00:00.000Z`));

/**
 * A timestamp that cannot be in the future.
 *
 * A refill "recorded" for next Tuesday is either a typo or an attempt to
 * backdate stock into a period that has already been reconciled.
 */
const pastTimestamp = z
  .string()
  .datetime({ message: 'Must be an ISO 8601 timestamp' })
  .transform((value) => new Date(value))
  .refine((value) => value <= new Date(), 'Cannot be in the future');

const objectKey = z.string().trim().max(512);

// --- Drivers ---------------------------------------------------------------

export const listDriversSchema = {
  query: z.object({
    employmentStatus: z.enum(Object.values(DRIVER_EMPLOYMENT_STATUS)).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  }),
};

/**
 * Onboard a driver: identity and employment record in one call.
 *
 * `phone` is the only identifier. It is what the driver signs in with, and the
 * app is OTP-only — there is no password to set and no email to collect.
 *
 * `fullName` is REQUIRED here although the profile column is nullable. A
 * dispatcher assigning work reads a name, and a customer expecting a delivery
 * is told one; an unnamed driver is a row nobody can act on. The nullable
 * column stays for the older `createDriverProfile` path and for rows the seeds
 * wrote before this endpoint existed.
 */
export const onboardDriverSchema = {
  body: z.object({
    phone: indianPhone,
    fullName: z.string().trim().min(1).max(120),
    employeeCode: z.string().trim().max(32).optional(),
    licenseNumber: z.string().trim().max(64).optional(),
    licenseExpiry: isoDate.optional(),
    licenseDocumentKey: objectKey.optional(),
    emergencyContactName: z.string().trim().max(120).optional(),
    emergencyContactPhone: indianPhone.optional(),
    joinedOn: isoDate.optional(),
    notes: z.string().trim().max(2000).optional(),
  }),
};

export const createDriverProfileSchema = {
  body: z.object({
    /**
     * The DRIVER identity must already exist (BR-301). This endpoint adds the
     * employment record; it never creates an account.
     */
    userId: uuid('User id'),
    employeeCode: z.string().trim().max(32).optional(),
    fullName: z.string().trim().min(1).max(120).optional(),
    licenseNumber: z.string().trim().max(64).optional(),
    licenseExpiry: isoDate.optional(),
    licenseDocumentKey: objectKey.optional(),
    profileImageKey: objectKey.optional(),
    emergencyContactName: z.string().trim().max(120).optional(),
    emergencyContactPhone: indianPhone.optional(),
    joinedOn: isoDate.optional(),
    notes: z.string().trim().max(2000).optional(),
  }),
};

export const updateDriverProfileSchema = {
  params: z.object({ id: uuid('Driver id') }),
  body: z
    .object({
      employeeCode: z.string().trim().max(32).nullable().optional(),
      fullName: z.string().trim().min(1).max(120).optional(),
      licenseNumber: z.string().trim().max(64).nullable().optional(),
      licenseExpiry: isoDate.nullable().optional(),
      licenseDocumentKey: objectKey.nullable().optional(),
      profileImageKey: objectKey.nullable().optional(),
      emergencyContactName: z.string().trim().max(120).nullable().optional(),
      emergencyContactPhone: indianPhone.nullable().optional(),
      joinedOn: isoDate.nullable().optional(),
      employmentStatus: z.enum(Object.values(DRIVER_EMPLOYMENT_STATUS)).optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update'),
};

// --- Vehicles --------------------------------------------------------------

const complianceFields = {
  pesoLicenseNumber: z.string().trim().max(64).optional(),
  pesoLicenseExpiry: isoDate.optional(),
  calibrationCertNumber: z.string().trim().max(64).optional(),
  calibrationExpiry: isoDate.optional(),
  insuranceExpiry: isoDate.optional(),
  pucExpiry: isoDate.optional(),
  fitnessExpiry: isoDate.optional(),
};

export const listVehiclesSchema = {
  query: z.object({
    status: z.enum(Object.values(VEHICLE_STATUS)).optional(),
    includeRetired: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  }),
};

export const createVehicleSchema = {
  body: z.object({
    vehicleNumber: z.string().trim().min(1).max(32).toUpperCase(),
    registrationNumber: z
      .string()
      .trim()
      .toUpperCase()
      .min(4)
      .max(24)
      .regex(/^[A-Z0-9-]+$/, 'Registration may contain only letters, digits and hyphens'),
    makeModel: z.string().trim().max(120).optional(),
    // A tanker with a zero-litre tank is not a tanker.
    tankCapacity: litres({ min: 0, allowZero: false, max: 100_000 }),
    compartmentCount: z.coerce.number().int().min(1).max(20).default(1),
    /** Recorded as an OPENING_BALANCE adjustment, never written directly. */
    openingFuelQuantity: litres().default('0'),
    ...complianceFields,
    notes: z.string().trim().max(2000).optional(),
  }),
};

export const updateVehicleSchema = {
  params: z.object({ id: uuid('Vehicle id') }),
  body: z
    .object({
      vehicleNumber: z.string().trim().min(1).max(32).toUpperCase().optional(),
      registrationNumber: z.string().trim().toUpperCase().min(4).max(24).optional(),
      makeModel: z.string().trim().max(120).nullable().optional(),
      tankCapacity: litres({ min: 0, allowZero: false }).optional(),
      compartmentCount: z.coerce.number().int().min(1).max(20).optional(),
      status: z.enum(Object.values(VEHICLE_STATUS)).optional(),
      retiredReason: z.string().trim().max(500).optional(),
      pesoLicenseNumber: z.string().trim().max(64).nullable().optional(),
      pesoLicenseExpiry: isoDate.nullable().optional(),
      calibrationCertNumber: z.string().trim().max(64).nullable().optional(),
      calibrationExpiry: isoDate.nullable().optional(),
      insuranceExpiry: isoDate.nullable().optional(),
      pucExpiry: isoDate.nullable().optional(),
      fitnessExpiry: isoDate.nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    })
    .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update')
    // Retiring is irreversible, so it must be explained.
    .refine(
      (body) => body.status !== VEHICLE_STATUS.RETIRED || Boolean(body.retiredReason),
      'A reason is required when retiring a vehicle'
    ),
};

export const vehicleIdSchema = {
  params: z.object({ id: uuid('Vehicle id') }),
};

export const assignDriverSchema = {
  params: z.object({ id: uuid('Vehicle id') }),
  body: z.object({ driverProfileId: uuid('Driver profile id') }),
};

export const unassignDriverSchema = {
  params: z.object({ id: uuid('Vehicle id') }),
  body: z.object({ reason: z.string().trim().max(500).optional() }),
};

export const assignmentHistorySchema = {
  params: z.object({ id: uuid('Vehicle id') }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  }),
};

// --- Inventory -------------------------------------------------------------

export const refillSchema = {
  params: z.object({ id: uuid('Vehicle id') }),
  body: z.object({
    /** Always an increase; the sign is applied by the service, not the caller. */
    quantity: litres({ allowZero: false }),
    depotName: z.string().trim().min(1).max(160),
    invoiceRef: z.string().trim().max(64).optional(),
    /** BR-410 asks for a photograph; not hard-required because depot
     *  paperwork is sometimes the only evidence available. */
    photoKey: objectKey.optional(),
    occurredAt: pastTimestamp.optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
};

export const manualAdjustmentSchema = {
  params: z.object({ id: uuid('Vehicle id') }),
  body: z.object({
    direction: z.enum(['INCREASE', 'DECREASE']),
    quantity: litres({ allowZero: false }),
    /**
     * BOTH are mandatory. An unexplained stock change is indistinguishable
     * from theft, and this endpoint is how someone would conceal one. Also
     * enforced by a database CHECK.
     */
    reasonCode: z
      .string()
      .trim()
      .toUpperCase()
      .min(3)
      .max(64)
      .regex(/^[A-Z0-9_]+$/, 'Reason code may contain only capitals, digits and underscores'),
    reason: z.string().trim().min(10, 'Explain the adjustment in a sentence').max(1000),
    photoKey: objectKey.optional(),
  }),
};

export const meterReadingSchema = {
  params: z.object({ id: uuid('Vehicle id') }),
  body: z.object({
    totalizer,
    readingType: z.enum(Object.values(METER_READING_TYPE)).default(METER_READING_TYPE.SPOT_CHECK),
    grossQuantity: litres().optional(),
    netQuantity: litres().optional(),
    temperatureC: z
      .string()
      .trim()
      .regex(/^-?\d{1,3}(\.\d{1,2})?$/, 'Temperature must be a decimal string')
      .optional(),
    /** BR-906: manual entry requires photographic evidence. */
    photoKey: objectKey,
    capturedAt: pastTimestamp.optional(),
    notes: z.string().trim().max(500).optional(),
  }),
};

// --- Shifts ----------------------------------------------------------------

export const listShiftsSchema = {
  query: z.object({
    status: z.enum(Object.values(SHIFT_STATUS)).optional(),
    driverProfileId: z.string().uuid().optional(),
    vehicleId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().uuid().optional(),
  }),
};

export const startShiftSchema = {
  body: z.object({
    driverProfileId: uuid('Driver profile id'),
    vehicleId: uuid('Vehicle id'),
    /** BR-306: the opening totaliser is captured at shift start. */
    openingTotalizer: totalizer,
    openingFuelQuantity: litres().optional(),
    /**
     * REQUIRED, not optional. The opening reading is a manual entry, and
     * BR-906 requires a photograph of the meter for those - it is the only
     * evidence that the typed number matches the dial. A database CHECK
     * enforces the same rule, so making this optional would surface as an
     * unhandled constraint violation rather than a validation error.
     */
    photoKey: objectKey,
    notes: z.string().trim().max(1000).optional(),
  }),
};

export const endShiftSchema = {
  body: z.object({
    shiftId: uuid('Shift id'),
    closingTotalizer: totalizer,
    closingFuelQuantity: litres().optional(),
    /** Required for the same reason as the opening reading (BR-906). */
    photoKey: objectKey,
    notes: z.string().trim().max(1000).optional(),
  }),
};
