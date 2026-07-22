import { z } from 'zod';

import { DEVICE_PLATFORM, PUBLIC_OTP_PURPOSES } from '../../shared/constants/identity.js';
import { PRINCIPALS } from '../../shared/constants/rbac.js';

/**
 * Request validation for the identity module.
 *
 * Schema concerns only: shape, type, format, bounds. Business validation
 * ("does this exceed the credit limit") belongs in services (docs/11 §4.3).
 */

/**
 * E.164. India-only in Phase 1 (BR-115), which is also the cheapest defence
 * against SMS-pumping fraud - an attacker cannot direct codes at premium
 * international ranges (BR-114).
 */
const phone = z
  .string()
  .trim()
  .regex(
    /^\+91[6-9]\d{9}$/,
    'Must be a valid Indian mobile number in E.164 form, e.g. +919876543210'
  );

const email = z.string().trim().toLowerCase().email('Must be a valid email address').max(255);

/**
 * Minimum 12 characters, and that is the whole rule.
 *
 * Composition requirements (one upper, one digit, one symbol) are not applied
 * deliberately: current NIST guidance drops them because they push users toward
 * predictable patterns like `Password1!` while barely raising real entropy.
 * Length plus a slow hash plus rate limiting does more.
 *
 * The 128-character ceiling is a denial-of-service guard - Argon2 cost scales
 * with input, so an unbounded password field is a cheap way to burn server CPU.
 */
const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

/**
 * Exactly one identifier. Requiring both would be wrong (customers may have no
 * email, BR-106); accepting neither leaves nothing to authenticate against.
 */
const oneIdentifier = (schema) =>
  schema.refine((value) => Boolean(value.phone) !== Boolean(value.email), {
    message: 'Provide exactly one of phone or email',
    path: ['phone'],
  });

/**
 * Optional client-supplied device metadata, for the "your devices" list.
 *
 * Never trusted for a security decision. `isTrusted` is deliberately absent -
 * a client that could mark its own device trusted would defeat the point.
 */
const deviceContext = {
  deviceId: z.string().trim().max(128).optional(),
  deviceName: z.string().trim().max(128).optional(),
  platform: z.enum(Object.values(DEVICE_PLATFORM)).optional(),
  appVersion: z.string().trim().max(32).optional(),
};

export const registerSchema = {
  body: oneIdentifier(
    z.object({
      phone: phone.optional(),
      email: email.optional(),
      password,
      /** DPDP Act 2023 consent capture (BR-107). */
      consentVersion: z.string().trim().max(32).optional(),
      ...deviceContext,
    })
  ),
};

export const loginSchema = {
  body: oneIdentifier(
    z.object({
      /**
       * Explicit rather than inferred. The same phone may be a customer and a
       * driver (BR-104), so the server cannot guess which account is meant -
       * and guessing would let a driver-app login match a customer record.
       */
      principal: z.enum([PRINCIPALS.CUSTOMER, PRINCIPALS.DRIVER, PRINCIPALS.ADMIN]),
      phone: phone.optional(),
      email: email.optional(),
      password: z.string().min(1, 'Password is required').max(128),
      ...deviceContext,
    })
  ),
};

export const refreshSchema = {
  body: z.object({
    refreshToken: z.string().min(1, 'Refresh token is required'),
  }),
};

export const sessionIdSchema = {
  params: z.object({
    id: z.string().uuid('Session id must be a UUID'),
  }),
};

/**
 * OTP request.
 *
 * Phone only. Email OTP would need a separate delivery channel and a different
 * abuse profile, and accepting an identifier the provider cannot deliver to
 * would just burn the caller's rate-limit budget.
 */
export const otpRequestSchema = {
  body: z.object({
    phone,
    principal: z.enum([PRINCIPALS.CUSTOMER, PRINCIPALS.DRIVER]),
    purpose: z.enum(PUBLIC_OTP_PURPOSES),
  }),
};

export const otpVerifySchema = {
  body: z.object({
    phone,
    principal: z.enum([PRINCIPALS.CUSTOMER, PRINCIPALS.DRIVER]),
    purpose: z.enum(PUBLIC_OTP_PURPOSES),
    /**
     * Digits only, and bounded. An unbounded field here feeds straight into
     * Argon2 verification, whose cost scales with input length.
     */
    code: z
      .string()
      .trim()
      .regex(/^\d{4,10}$/, 'Code must be 4 to 10 digits'),
    ...deviceContext,
  }),
};
