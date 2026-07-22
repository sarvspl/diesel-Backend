import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Data access for corporate accounts, members and verification history.
 *
 * Kept as one repository because the three tables form a single aggregate:
 * every meaningful write touches at least two of them, and splitting them
 * would mean transactions spanning repositories.
 */

const ACCOUNT_FIELDS = {
  id: true,
  legalName: true,
  displayName: true,
  registrationIdType: true,
  registrationNumber: true,
  gstin: true,
  pan: true,
  billingLine1: true,
  billingLine2: true,
  billingCity: true,
  billingState: true,
  billingPincode: true,
  contactEmail: true,
  contactPhone: true,
  verificationStatus: true,
  accountStatus: true,
  creditFacilityStatus: true,
  createdAt: true,
  updatedAt: true,
};

const MEMBER_FIELDS = {
  id: true,
  corporateAccountId: true,
  userId: true,
  role: true,
  status: true,
  removedAt: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, phone: true, email: true, status: true } },
};

export const findAccountById = async (id) =>
  prisma.corporateAccount.findUnique({ where: { id }, select: ACCOUNT_FIELDS });

export const findByRegistration = async ({ registrationIdType, registrationNumber }) =>
  prisma.corporateAccount.findUnique({
    where: { registrationIdType_registrationNumber: { registrationIdType, registrationNumber } },
    select: { id: true, verificationStatus: true },
  });

/**
 * Every ACTIVE membership for a user, with the parent account's two gating
 * statuses.
 *
 * This is the query the login gate runs on every authentication, so it is
 * deliberately narrow - three columns, one index hit.
 */
export const findActiveMembershipsForUser = async (userId) =>
  prisma.corporateMember.findMany({
    where: { userId, status: 'ACTIVE' },
    select: {
      id: true,
      role: true,
      corporateAccountId: true,
      corporateAccount: {
        select: {
          id: true,
          displayName: true,
          verificationStatus: true,
          accountStatus: true,
          creditFacilityStatus: true,
        },
      },
    },
  });

/**
 * Create the account, its owner membership and the opening verification record
 * in ONE transaction.
 *
 * All three or none: an account with no owner cannot be administered and cannot
 * be repaired through any endpoint, and an account with no verification record
 * has no submission history (BR-207).
 */
export const createRegistration = async ({ account, ownerUserId }) =>
  prisma.$transaction(async (tx) => {
    const created = await tx.corporateAccount.create({
      data: {
        ...account,
        createdByUserId: ownerUserId,
        // Explicit rather than relying on defaults: these two are the heart of
        // BR-202 and BR-208 and should be readable at the call site.
        verificationStatus: 'PENDING',
        accountStatus: 'INACTIVE',
        creditFacilityStatus: 'NOT_ENABLED',
        members: {
          create: {
            userId: ownerUserId,
            role: 'CORPORATE_OWNER',
            status: 'ACTIVE',
          },
        },
        verificationRecords: {
          create: {
            fromStatus: null,
            toStatus: 'PENDING',
            applicantNote: 'Registration submitted',
          },
        },
      },
      select: ACCOUNT_FIELDS,
    });

    return created;
  });

/**
 * Record a verification decision and apply its consequences atomically.
 *
 * The history row and the status change must never diverge - a status with no
 * record explaining it is exactly what BR-207 exists to prevent.
 *
 * `accountStatus` is passed in rather than derived here: approval sets ACTIVE
 * (BR-208) while rejection leaves INACTIVE, and that policy belongs in the
 * service, not the data layer.
 */
export const recordVerificationDecision = async ({
  corporateAccountId,
  fromStatus,
  toStatus,
  accountStatus,
  reasonCode,
  applicantNote,
  adminNote,
  reviewedByUserId,
}) =>
  prisma.$transaction(async (tx) => {
    await tx.corporateVerificationRecord.create({
      data: {
        corporateAccountId,
        fromStatus,
        toStatus,
        reasonCode: reasonCode ?? null,
        applicantNote: applicantNote ?? null,
        adminNote: adminNote ?? null,
        reviewedByUserId,
      },
    });

    return tx.corporateAccount.update({
      where: { id: corporateAccountId },
      data: {
        verificationStatus: toStatus,
        ...(accountStatus ? { accountStatus } : {}),
      },
      select: ACCOUNT_FIELDS,
    });
  });

/**
 * Verification history for an account.
 *
 * `adminNote` is excluded from the default projection. It is internal and must
 * never reach the company being reviewed; admin endpoints opt in explicitly.
 */
export const listVerificationRecords = async ({ corporateAccountId, includeAdminNotes = false }) =>
  prisma.corporateVerificationRecord.findMany({
    where: { corporateAccountId },
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      reasonCode: true,
      applicantNote: true,
      reviewedByUserId: true,
      createdAt: true,
      ...(includeAdminNotes ? { adminNote: true } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });

export const listPendingAccounts = async ({ limit, cursor }) =>
  prisma.corporateAccount.findMany({
    where: { verificationStatus: 'PENDING' },
    select: { ...ACCOUNT_FIELDS, createdByUserId: true },
    // Oldest first: a review queue is fair only if it is a queue.
    orderBy: { createdAt: 'asc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

const buildAccountWhere = ({ verificationStatus, accountStatus, search }) => {
  const where = {};

  if (verificationStatus) where.verificationStatus = verificationStatus;
  if (accountStatus) where.accountStatus = accountStatus;

  if (search) {
    const term = search.trim();
    where.OR = [
      { legalName: { contains: term, mode: 'insensitive' } },
      { displayName: { contains: term, mode: 'insensitive' } },
      { registrationNumber: { contains: term.toUpperCase() } },
      { gstin: { contains: term.toUpperCase() } },
    ];
  }

  return where;
};

/**
 * The general admin list, filterable on both status axes independently.
 *
 * Newest first, unlike the pending QUEUE above: this is a directory to search,
 * not a backlog to work through, and the most recent registration is the one an
 * operator is most likely looking for.
 */
export const listAccounts = async ({ limit, cursor, verificationStatus, accountStatus, search }) =>
  prisma.corporateAccount.findMany({
    where: buildAccountWhere({ verificationStatus, accountStatus, search }),
    select: { ...ACCOUNT_FIELDS, createdByUserId: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

export const countAccountsByVerification = async () =>
  prisma.corporateAccount.groupBy({
    by: ['verificationStatus'],
    _count: { _all: true },
  });

/**
 * Change the operational axis ONLY.
 *
 * `verificationStatus` is deliberately never written here: suspending an
 * approved company must not erase the fact that it was legitimately verified
 * (BR-213), and reactivation must not look like a fresh approval.
 *
 * The history row and the status change go in one transaction for the same
 * reason as a verification decision - a status with nothing explaining it is
 * exactly what BR-207 exists to prevent.
 */
export const recordAccountStatusChange = async ({
  corporateAccountId,
  verificationStatus,
  accountStatus,
  reasonCode,
  applicantNote,
  adminNote,
  reviewedByUserId,
}) =>
  prisma.$transaction(async (tx) => {
    await tx.corporateVerificationRecord.create({
      data: {
        corporateAccountId,
        // Verification is unchanged, so both ends of the record carry its
        // current value. The account-status move lives in the note.
        fromStatus: verificationStatus,
        toStatus: verificationStatus,
        reasonCode: reasonCode ?? null,
        applicantNote: applicantNote ?? null,
        adminNote: adminNote ?? null,
        reviewedByUserId,
      },
    });

    return tx.corporateAccount.update({
      where: { id: corporateAccountId },
      data: { accountStatus },
      select: ACCOUNT_FIELDS,
    });
  });

// --- Members ---------------------------------------------------------------

export const listMembers = async ({ corporateAccountId, includeRemoved = false }) =>
  prisma.corporateMember.findMany({
    where: {
      corporateAccountId,
      ...(includeRemoved ? {} : { status: 'ACTIVE' }),
    },
    select: MEMBER_FIELDS,
    orderBy: { createdAt: 'asc' },
  });

export const findMember = async ({ id, corporateAccountId }) =>
  prisma.corporateMember.findFirst({
    where: { id, corporateAccountId },
    select: MEMBER_FIELDS,
  });

export const findMembershipForUser = async ({ userId, corporateAccountId }) =>
  prisma.corporateMember.findFirst({
    where: { userId, corporateAccountId, status: 'ACTIVE' },
    select: MEMBER_FIELDS,
  });

export const countActiveOwners = async (corporateAccountId) =>
  prisma.corporateMember.count({
    where: { corporateAccountId, role: 'CORPORATE_OWNER', status: 'ACTIVE' },
  });

/**
 * Add a member, or reactivate one who was previously removed.
 *
 * Upsert on the (account, user) unique pair: a second row for the same person
 * would make "who is a member" ambiguous, and removal is soft so the old row is
 * still there.
 */
export const upsertMember = async ({ corporateAccountId, userId, role, addedByUserId }) =>
  prisma.corporateMember.upsert({
    where: { corporateAccountId_userId: { corporateAccountId, userId } },
    create: { corporateAccountId, userId, role, addedByUserId, status: 'ACTIVE' },
    update: { role, status: 'ACTIVE', removedAt: null, removedByUserId: null, addedByUserId },
    select: MEMBER_FIELDS,
  });

export const updateMemberRole = async ({ id, role }) =>
  prisma.corporateMember.update({ where: { id }, data: { role }, select: MEMBER_FIELDS });

/** Soft removal: order attribution must survive the person leaving (BR-223). */
export const removeMember = async ({ id, removedByUserId }) =>
  prisma.corporateMember.update({
    where: { id },
    data: { status: 'REMOVED', removedAt: new Date(), removedByUserId },
    select: MEMBER_FIELDS,
  });
