import {
  CORPORATE_ACCOUNT_STATUS,
  CORPORATE_VERIFICATION_STATUS,
} from '../../../shared/constants/corporate.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as corporateRepository from '../repositories/corporate.repository.js';

import { toPublicAccount } from './corporate.service.js';

const log = createLogger({ module: 'corporate.verification' });

/**
 * Administrative review of corporate registrations.
 *
 * The decision is APPEND-ONLY history plus a status change, written together
 * (BR-207). Nothing here ever rewrites a previous decision: re-applying after
 * rejection adds a record, it does not erase the rejection (BR-206).
 */

export const listPending = async ({ limit = 25, cursor } = {}) => {
  const accounts = await corporateRepository.listPendingAccounts({ limit: limit + 1, cursor });
  const hasMore = accounts.length > limit;
  const page = hasMore ? accounts.slice(0, limit) : accounts;

  return {
    corporates: page.map((account) => ({
      ...toPublicAccount(account),
      submittedByUserId: account.createdByUserId,
    })),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

/**
 * The general admin directory, filterable on both status axes.
 *
 * Separate from `listPending` rather than a superset of it: the pending queue
 * is ordered oldest-first because it is a QUEUE and fairness matters, while
 * this is newest-first because it is a directory being searched. Merging them
 * would mean one of the two orderings is wrong.
 */
export const listCorporates = async ({
  limit = 25,
  cursor,
  verificationStatus,
  accountStatus,
  search,
} = {}) => {
  const accounts = await corporateRepository.listAccounts({
    limit: limit + 1,
    cursor,
    verificationStatus,
    accountStatus,
    search,
  });

  const hasMore = accounts.length > limit;
  const page = hasMore ? accounts.slice(0, limit) : accounts;

  return {
    corporates: page.map((account) => ({
      ...toPublicAccount(account),
      submittedByUserId: account.createdByUserId,
    })),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

/** Counts per verification status, for the review-queue badge and dashboard. */
export const countsByVerification = async () => {
  const rows = await corporateRepository.countAccountsByVerification();

  const counts = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
  for (const row of rows) {
    counts[row.verificationStatus] = row._count._all;
  }

  return counts;
};

/**
 * Suspend or reactivate an approved company.
 *
 * This moves the OPERATIONAL axis only. Verification is untouched, so an
 * approved company that stops paying is suspended without losing the record
 * that it was ever legitimately verified, and reactivation needs no
 * re-verification (BR-213, BR-214).
 *
 * Only an APPROVED company can be suspended: a PENDING or REJECTED one was
 * never active, so there is nothing to suspend and writing a status would blur
 * the two axes.
 */
const changeAccountStatus = async ({
  corporateAccountId,
  reviewerUserId,
  targetStatus,
  reasonCode,
  reason,
  adminNote,
}) => {
  const account = await corporateRepository.findAccountById(corporateAccountId);

  if (!account) {
    throw new NotFoundError('Corporate account not found');
  }

  if (account.verificationStatus !== CORPORATE_VERIFICATION_STATUS.APPROVED) {
    throw new ConflictError('Only an approved company has an account status to change', {
      code: ERROR_CODES.CORPORATE_ALREADY_DECIDED,
    });
  }

  if (account.accountStatus === targetStatus) {
    throw new ConflictError(`This company is already ${targetStatus.toLowerCase()}`, {
      code: ERROR_CODES.CONFLICT,
    });
  }

  const updated = await corporateRepository.recordAccountStatusChange({
    corporateAccountId,
    verificationStatus: account.verificationStatus,
    accountStatus: targetStatus,
    reasonCode,
    applicantNote: reason,
    adminNote: adminNote ?? null,
    reviewedByUserId: reviewerUserId,
  });

  log.info(
    { corporateAccountId, reviewerUserId, from: account.accountStatus, to: targetStatus },
    'corporate account status changed'
  );

  return toPublicAccount(updated);
};

export const suspend = async ({ corporateAccountId, reviewerUserId, reason, adminNote }) =>
  changeAccountStatus({
    corporateAccountId,
    reviewerUserId,
    targetStatus: CORPORATE_ACCOUNT_STATUS.SUSPENDED,
    reasonCode: 'ACCOUNT_SUSPENDED',
    reason,
    adminNote,
  });

export const reactivate = async ({ corporateAccountId, reviewerUserId, reason, adminNote }) =>
  changeAccountStatus({
    corporateAccountId,
    reviewerUserId,
    targetStatus: CORPORATE_ACCOUNT_STATUS.ACTIVE,
    reasonCode: 'ACCOUNT_REACTIVATED',
    reason,
    adminNote,
  });

/** Full detail including internal notes. Admin-only projection. */
export const getForReview = async (corporateAccountId) => {
  const account = await corporateRepository.findAccountById(corporateAccountId);

  if (!account) {
    throw new NotFoundError('Corporate account not found');
  }

  const history = await corporateRepository.listVerificationRecords({
    corporateAccountId,
    includeAdminNotes: true,
  });

  const members = await corporateRepository.listMembers({ corporateAccountId });

  return {
    account: toPublicAccount(account),
    verificationHistory: history,
    members: members.map((member) => ({
      id: member.id,
      userId: member.userId,
      role: member.role,
      phone: member.user?.phone ?? null,
    })),
  };
};

/**
 * Approve a registration.
 *
 * Sets BOTH axes that approval governs, and neither more:
 *   verification -> APPROVED   the company is real
 *   account      -> ACTIVE     it may now operate (BR-208)
 *
 * Credit is deliberately untouched and stays NOT_ENABLED. Approving a company
 * is a compliance decision; extending it credit is a separate commercial one
 * made by finance (BR-230). Conflating them is the single most common
 * misreading of this workflow.
 */
export const approve = async ({ corporateAccountId, reviewerUserId, applicantNote, adminNote }) => {
  const account = await corporateRepository.findAccountById(corporateAccountId);

  if (!account) {
    throw new NotFoundError('Corporate account not found');
  }

  if (account.verificationStatus === CORPORATE_VERIFICATION_STATUS.APPROVED) {
    // Not idempotent-success: a second approval would append a misleading
    // history record suggesting a fresh decision was taken.
    throw new ConflictError('This company is already approved', {
      code: ERROR_CODES.CORPORATE_ALREADY_DECIDED,
    });
  }

  const updated = await corporateRepository.recordVerificationDecision({
    corporateAccountId,
    fromStatus: account.verificationStatus,
    toStatus: CORPORATE_VERIFICATION_STATUS.APPROVED,
    accountStatus: CORPORATE_ACCOUNT_STATUS.ACTIVE,
    applicantNote: applicantNote ?? null,
    adminNote: adminNote ?? null,
    reviewedByUserId: reviewerUserId,
  });

  log.info({ corporateAccountId, reviewerUserId }, 'corporate registration approved');

  return toPublicAccount(updated);
};

/**
 * Reject a registration.
 *
 * `reasonCode` and `applicantNote` are both required and both shown to the
 * applicant (BR-205) - a rejection with no explanation is unappealable and
 * generates a support call every time.
 *
 * `accountStatus` is NOT changed: it stays INACTIVE. A rejected company was
 * never active, so there is nothing to deactivate, and writing a status here
 * would blur the two axes.
 */
export const reject = async ({
  corporateAccountId,
  reviewerUserId,
  reasonCode,
  applicantNote,
  adminNote,
}) => {
  const account = await corporateRepository.findAccountById(corporateAccountId);

  if (!account) {
    throw new NotFoundError('Corporate account not found');
  }

  if (account.verificationStatus === CORPORATE_VERIFICATION_STATUS.REJECTED) {
    throw new ConflictError('This company has already been rejected', {
      code: ERROR_CODES.CORPORATE_ALREADY_DECIDED,
    });
  }

  const updated = await corporateRepository.recordVerificationDecision({
    corporateAccountId,
    fromStatus: account.verificationStatus,
    toStatus: CORPORATE_VERIFICATION_STATUS.REJECTED,
    // Explicitly null: rejection must not touch the operational axis.
    accountStatus: null,
    reasonCode,
    applicantNote,
    adminNote: adminNote ?? null,
    reviewedByUserId: reviewerUserId,
  });

  log.info({ corporateAccountId, reviewerUserId, reasonCode }, 'corporate registration rejected');

  return toPublicAccount(updated);
};
