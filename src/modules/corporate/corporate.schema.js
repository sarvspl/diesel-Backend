import { z } from 'zod';

import {
  ASSIGNABLE_MEMBER_ROLES,
  CORPORATE_ACCOUNT_STATUS,
  CORPORATE_REGISTRATION_ID_TYPE,
  CORPORATE_VERIFICATION_STATUS,
} from '../../shared/constants/corporate.js';

/** Request validation for the corporate module. */

const indianPhone = z
  .string()
  .trim()
  .regex(/^\+91[6-9]\d{9}$/, 'Must be a valid Indian mobile number, e.g. +919876543210');

const pincode = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Must be a 6-digit Indian PIN code');

/**
 * GSTIN and PAN have well-defined, checkable formats, so they are validated
 * even though both are optional. The corporate REGISTRATION identifier is not:
 * which identifier is required is OQ-01 and still open, so its format is
 * checked only for length and character class. Tightening it later is a
 * validation change, not a migration - which is why the TYPE is stored
 * alongside the number.
 */
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]$/, 'Must be a valid 15-character GSTIN');

const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Must be a valid 10-character PAN');

const registrationNumber = z
  .string()
  .trim()
  .toUpperCase()
  .min(6, 'Registration number looks too short')
  .max(64)
  .regex(/^[A-Z0-9-]+$/, 'Registration number may contain only letters, digits and hyphens');

export const registerCorporateSchema = {
  body: z.object({
    legalName: z.string().trim().min(2).max(255),
    /** Falls back to legalName in the service when omitted. */
    displayName: z.string().trim().min(2).max(255).optional(),

    registrationIdType: z.enum(Object.values(CORPORATE_REGISTRATION_ID_TYPE)),
    registrationNumber,

    gstin: gstin.optional(),
    pan: pan.optional(),

    billingLine1: z.string().trim().max(255).optional(),
    billingLine2: z.string().trim().max(255).optional(),
    billingCity: z.string().trim().max(120).optional(),
    billingState: z.string().trim().max(120).optional(),
    billingPincode: pincode.optional(),

    contactEmail: z.string().trim().toLowerCase().email().max(255).optional(),
    contactPhone: indianPhone.optional(),
  }),
};

export const addMemberSchema = {
  body: z.object({
    /**
     * By phone, not by user id. A caller must not be able to probe the platform
     * for valid user ids, and a phone number is something they already know
     * about a colleague.
     */
    phone: indianPhone,
    role: z.enum(ASSIGNABLE_MEMBER_ROLES),
  }),
};

export const updateMemberSchema = {
  params: z.object({ id: z.string().uuid('Member id must be a UUID') }),
  body: z.object({ role: z.enum(ASSIGNABLE_MEMBER_ROLES) }),
};

export const memberIdSchema = {
  params: z.object({ id: z.string().uuid('Member id must be a UUID') }),
};

// --- Admin -----------------------------------------------------------------

export const corporateIdSchema = {
  params: z.object({ id: z.string().uuid('Corporate id must be a UUID') }),
};

export const listPendingSchema = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
  }),
};

/**
 * The general admin list.
 *
 * Filters on the two axes independently, because they ARE independent
 * (BR-213): an APPROVED company may be SUSPENDED, and collapsing the pair into
 * one "status" filter makes that combination unexpressible.
 */
export const listCorporatesSchema = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().uuid().optional(),
    verificationStatus: z.enum(Object.values(CORPORATE_VERIFICATION_STATUS)).optional(),
    accountStatus: z.enum(Object.values(CORPORATE_ACCOUNT_STATUS)).optional(),
    search: z.string().trim().min(1).max(120).optional(),
  }),
};

/**
 * Suspend or reactivate.
 *
 * A reason is MANDATORY on both. Every account-status change requires an
 * actor, a reason and an audit entry (BR-215), and a reason captured after the
 * fact is a reason invented after the fact.
 */
export const changeAccountStatusSchema = {
  params: corporateIdSchema.params,
  body: z.object({
    reason: z.string().trim().min(3, 'Give a reason - it is recorded').max(1000),
    adminNote: z.string().trim().max(2000).optional(),
  }),
};

export const approveCorporateSchema = {
  params: corporateIdSchema.params,
  body: z.object({
    /** Optional note shown to the applicant. */
    applicantNote: z.string().trim().max(1000).optional(),
    /** Internal. Never returned to the company (see the repository projection). */
    adminNote: z.string().trim().max(2000).optional(),
  }),
};

export const rejectCorporateSchema = {
  params: corporateIdSchema.params,
  body: z.object({
    /**
     * Both required by BR-205. A rejection the applicant cannot understand is
     * unappealable and produces a support call every single time.
     */
    reasonCode: z
      .string()
      .trim()
      .toUpperCase()
      .min(3)
      .max(64)
      .regex(/^[A-Z0-9_]+$/, 'Reason code may contain only capitals, digits and underscores'),
    applicantNote: z.string().trim().min(1, 'Explain the rejection to the applicant').max(1000),
    adminNote: z.string().trim().max(2000).optional(),
  }),
};
