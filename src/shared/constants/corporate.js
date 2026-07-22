/**
 * JavaScript mirrors of the corporate Prisma enums.
 *
 * Same reasoning as shared/constants/identity.js: without a compiler, a bare
 * string literal that drifts from the schema fails at runtime on whichever
 * branch happens to use it. The enum-parity test asserts these match
 * schema.prisma.
 */

export const CORPORATE_VERIFICATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

export const CORPORATE_ACCOUNT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  INACTIVE: 'INACTIVE',
});

export const CORPORATE_CREDIT_FACILITY_STATUS = Object.freeze({
  NOT_ENABLED: 'NOT_ENABLED',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  CLOSED: 'CLOSED',
});

export const CORPORATE_MEMBER_ROLE = Object.freeze({
  CORPORATE_OWNER: 'CORPORATE_OWNER',
  CORPORATE_ADMIN: 'CORPORATE_ADMIN',
  PURCHASE_MANAGER: 'PURCHASE_MANAGER',
  VIEWER: 'VIEWER',
});

export const CORPORATE_MEMBER_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  REMOVED: 'REMOVED',
});

export const CORPORATE_REGISTRATION_ID_TYPE = Object.freeze({
  CIN: 'CIN',
  GSTIN: 'GSTIN',
  PAN: 'PAN',
  UDYAM: 'UDYAM',
  OTHER: 'OTHER',
});

/**
 * Which member roles may manage other members.
 *
 * Expressed as data rather than an `if` chain in middleware, so the rule is
 * readable in one place and testable without an HTTP request. Note that
 * PURCHASE_MANAGER and VIEWER are absent: raising orders does not imply the
 * ability to grant someone else that power.
 */
export const MEMBER_MANAGING_ROLES = Object.freeze([
  CORPORATE_MEMBER_ROLE.CORPORATE_OWNER,
  CORPORATE_MEMBER_ROLE.CORPORATE_ADMIN,
]);

/**
 * Roles a member-manager may assign.
 *
 * CORPORATE_OWNER is absent deliberately: ownership transfer is a distinct
 * operation with its own rule (exactly one owner, BR-222) and must not happen
 * as a side effect of an ordinary role change.
 */
export const ASSIGNABLE_MEMBER_ROLES = Object.freeze([
  CORPORATE_MEMBER_ROLE.CORPORATE_ADMIN,
  CORPORATE_MEMBER_ROLE.PURCHASE_MANAGER,
  CORPORATE_MEMBER_ROLE.VIEWER,
]);
