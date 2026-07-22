import {
  CORPORATE_MEMBER_ROLE,
  CORPORATE_VERIFICATION_STATUS,
} from '../../../shared/constants/corporate.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as corporateRepository from '../repositories/corporate.repository.js';

const log = createLogger({ module: 'corporate.account' });

/**
 * Corporate account registration and self-service reads.
 *
 * THE RULE THIS MODULE EXISTS TO PROTECT (BR-2.1, ADR-007):
 *
 *   verificationStatus    is this a real company?      set by admin review
 *   accountStatus         may they operate today?      operational lever
 *   creditFacilityStatus  may they buy on credit?      commercial lever
 *
 * They move independently. Approving a company sets accountStatus ACTIVE and
 * leaves credit NOT_ENABLED (BR-208, BR-230). Suspending one later changes
 * accountStatus ONLY and must never touch verificationStatus, or the record
 * that the company was ever legitimately verified is destroyed (BR-213).
 */

const toPublicAccount = (account) => ({
  id: account.id,
  legalName: account.legalName,
  displayName: account.displayName,
  registration: {
    idType: account.registrationIdType,
    number: account.registrationNumber,
  },
  gstin: account.gstin,
  pan: account.pan,
  billingAddress: {
    line1: account.billingLine1,
    line2: account.billingLine2,
    city: account.billingCity,
    state: account.billingState,
    pincode: account.billingPincode,
  },
  contactEmail: account.contactEmail,
  contactPhone: account.contactPhone,
  // The three axes, always reported together so a client never has to infer
  // one from another.
  verificationStatus: account.verificationStatus,
  accountStatus: account.accountStatus,
  creditFacilityStatus: account.creditFacilityStatus,
  createdAt: account.createdAt,
  updatedAt: account.updatedAt,
});

/**
 * Submit a corporate registration.
 *
 * The caller becomes CORPORATE_OWNER. They can already authenticate - identity
 * exists first - but from this point their login is gated until an
 * administrator approves the company (BR-203, see corporate-gate.js).
 */
export const registerCorporate = async ({ userId, ...input }) => {
  const existingMemberships = await corporateRepository.findActiveMembershipsForUser(userId);

  if (existingMemberships.length > 0) {
    throw new ConflictError('This account already belongs to a company', {
      code: ERROR_CODES.ALREADY_CORPORATE_MEMBER,
    });
  }

  const duplicate = await corporateRepository.findByRegistration({
    registrationIdType: input.registrationIdType,
    registrationNumber: input.registrationNumber,
  });

  if (duplicate) {
    // Deliberately does not say whether the existing account was approved or
    // rejected: that is information about another company.
    throw new ConflictError('A company is already registered with this identifier', {
      code: ERROR_CODES.CORPORATE_ALREADY_REGISTERED,
    });
  }

  const account = await corporateRepository.createRegistration({
    ownerUserId: userId,
    account: {
      legalName: input.legalName,
      displayName: input.displayName ?? input.legalName,
      registrationIdType: input.registrationIdType,
      registrationNumber: input.registrationNumber,
      gstin: input.gstin ?? null,
      pan: input.pan ?? null,
      billingLine1: input.billingLine1 ?? null,
      billingLine2: input.billingLine2 ?? null,
      billingCity: input.billingCity ?? null,
      billingState: input.billingState ?? null,
      billingPincode: input.billingPincode ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
    },
  });

  log.info({ userId, corporateAccountId: account.id }, 'corporate registration submitted');

  return {
    account: toPublicAccount(account),
    /**
     * Told explicitly, because the applicant's existing session keeps working
     * until it is refreshed and the experience would otherwise be baffling:
     * they registered successfully and are then locked out.
     */
    nextStep: 'AWAITING_ADMIN_REVIEW',
    message:
      'Your registration is under review. You will not be able to sign in again until it is approved.',
  };
};

/**
 * The caller's own company.
 *
 * The account id comes from the caller's MEMBERSHIP, never from a request
 * parameter - that is the whole of BR-225 in one line.
 */
export const getMyCorporate = async (userId) => {
  const memberships = await corporateRepository.findActiveMembershipsForUser(userId);

  if (memberships.length === 0) {
    throw new NotFoundError('This account does not belong to a company', {
      code: ERROR_CODES.NOT_CORPORATE_MEMBER,
    });
  }

  const [membership] = memberships;
  const account = await corporateRepository.findAccountById(membership.corporateAccountId);

  const history = await corporateRepository.listVerificationRecords({
    corporateAccountId: account.id,
    // Never for a corporate caller: adminNote is internal and may contain the
    // reviewer's assessment of the very company reading it.
    includeAdminNotes: false,
  });

  return {
    account: toPublicAccount(account),
    membership: { id: membership.id, role: membership.role },
    verificationHistory: history,
  };
};

/**
 * Resolve the caller's company and role, for endpoints that act on it.
 *
 * @throws {NotFoundError}  not a member of any company
 * @throws {ForbiddenError} a member, but not of a company that may operate
 */
export const resolveActiveMembership = async (userId) => {
  const memberships = await corporateRepository.findActiveMembershipsForUser(userId);

  if (memberships.length === 0) {
    throw new NotFoundError('This account does not belong to a company', {
      code: ERROR_CODES.NOT_CORPORATE_MEMBER,
    });
  }

  const [membership] = memberships;

  if (membership.corporateAccount.verificationStatus !== CORPORATE_VERIFICATION_STATUS.APPROVED) {
    throw new ForbiddenError('Your company registration is still being reviewed', {
      code: ERROR_CODES.CORPORATE_VERIFICATION_PENDING,
    });
  }

  return membership;
};

export { toPublicAccount, CORPORATE_MEMBER_ROLE };
