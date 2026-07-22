import {
  ASSIGNABLE_MEMBER_ROLES,
  CORPORATE_MEMBER_ROLE,
  MEMBER_MANAGING_ROLES,
} from '../../../shared/constants/corporate.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { PRINCIPALS } from '../../../shared/constants/rbac.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as userRepository from '../../identity/repositories/user.repository.js';
import * as corporateRepository from '../repositories/corporate.repository.js';

const log = createLogger({ module: 'corporate.member' });

/**
 * Corporate membership management.
 *
 * Two independent authorisation layers apply, and conflating them is the
 * mistake this module is built to avoid:
 *
 *   PLATFORM permission   `corporate.member.manage` - "may act on my company"
 *   MEMBER role           OWNER/ADMIN               - "may manage members of THIS company"
 *
 * A platform permission cannot express "owner of company X but a viewer of
 * company Y", so the member role is checked here against the caller's actual
 * membership, read fresh from the database.
 *
 * Read fresh, NOT from the token, deliberately: member roles are embedded
 * nowhere, so demoting or removing someone takes effect immediately rather
 * than at their next access-token expiry. For an operation that grants and
 * revokes purchasing authority, a 15-minute stale window is too long.
 */

const toPublicMember = (member) => ({
  id: member.id,
  userId: member.userId,
  role: member.role,
  status: member.status,
  phone: member.user?.phone ?? null,
  email: member.user?.email ?? null,
  removedAt: member.removedAt,
  createdAt: member.createdAt,
});

/** @throws {ForbiddenError} when the caller's member role may not manage members. */
const assertCanManageMembers = (membership) => {
  if (!MEMBER_MANAGING_ROLES.includes(membership.role)) {
    throw new ForbiddenError('Only a company owner or admin can manage members', {
      code: ERROR_CODES.INSUFFICIENT_CORPORATE_ROLE,
    });
  }
};

export const listMembers = async ({ membership, includeRemoved = false }) => {
  const members = await corporateRepository.listMembers({
    corporateAccountId: membership.corporateAccountId,
    includeRemoved,
  });

  return members.map(toPublicMember);
};

/**
 * Add a member by phone number.
 *
 * Invitations are out of scope, so the target must already have a customer
 * identity - membership links an EXISTING user to a company, it never creates
 * one. Creating an identity here would mint an account the person never
 * consented to and cannot control.
 */
export const addMember = async ({ membership, actorUserId, phone, role }) => {
  assertCanManageMembers(membership);

  if (!ASSIGNABLE_MEMBER_ROLES.includes(role)) {
    // CORPORATE_OWNER is not assignable through this path: ownership transfer
    // is its own operation with the single-owner rule attached (BR-222).
    throw new BadRequestError('That role cannot be assigned directly', {
      code: ERROR_CODES.ROLE_NOT_ASSIGNABLE,
    });
  }

  const user = await userRepository.findByIdentifierForAuth({
    principal: PRINCIPALS.CUSTOMER,
    phone,
  });

  if (!user) {
    throw new NotFoundError(
      'No account exists for that number. Ask them to sign up first, then add them.',
      { code: ERROR_CODES.USER_NOT_FOUND }
    );
  }

  const otherMemberships = await corporateRepository.findActiveMembershipsForUser(user.id);
  const belongsElsewhere = otherMemberships.some(
    (existing) => existing.corporateAccountId !== membership.corporateAccountId
  );

  if (belongsElsewhere) {
    throw new ConflictError('That person already belongs to another company', {
      code: ERROR_CODES.ALREADY_CORPORATE_MEMBER,
    });
  }

  // Upsert, so re-adding someone who was removed reactivates their original
  // row rather than creating a duplicate membership.
  const member = await corporateRepository.upsertMember({
    corporateAccountId: membership.corporateAccountId,
    userId: user.id,
    role,
    addedByUserId: actorUserId,
  });

  log.info(
    { corporateAccountId: membership.corporateAccountId, memberId: member.id, role },
    'corporate member added'
  );

  return toPublicMember(member);
};

/**
 * Change a member's role.
 *
 * Cannot promote to or demote from CORPORATE_OWNER. Demoting the only owner
 * would leave a company nobody can administer, and the recovery path is an
 * administrator with database access (BR-222).
 */
export const updateMemberRole = async ({ membership, memberId, role }) => {
  assertCanManageMembers(membership);

  if (!ASSIGNABLE_MEMBER_ROLES.includes(role)) {
    throw new BadRequestError('That role cannot be assigned directly', {
      code: ERROR_CODES.ROLE_NOT_ASSIGNABLE,
    });
  }

  const target = await corporateRepository.findMember({
    id: memberId,
    // Scoped to the caller's company: a member id from another company simply
    // does not resolve, so there is no cross-company write path (BR-225).
    corporateAccountId: membership.corporateAccountId,
  });

  if (!target || target.status !== 'ACTIVE') {
    throw new NotFoundError('Member not found');
  }

  if (target.role === CORPORATE_MEMBER_ROLE.CORPORATE_OWNER) {
    throw new ForbiddenError('The company owner cannot be demoted. Transfer ownership first.', {
      code: ERROR_CODES.CANNOT_MODIFY_OWNER,
    });
  }

  const updated = await corporateRepository.updateMemberRole({ id: memberId, role });

  log.info({ memberId, role }, 'corporate member role changed');

  return toPublicMember(updated);
};

/**
 * Remove a member.
 *
 * Soft removal: access stops immediately, but the row survives so order
 * attribution to that person remains intact (BR-223, BR-224).
 */
export const removeMember = async ({ membership, actorUserId, memberId }) => {
  assertCanManageMembers(membership);

  const target = await corporateRepository.findMember({
    id: memberId,
    corporateAccountId: membership.corporateAccountId,
  });

  if (!target || target.status !== 'ACTIVE') {
    throw new NotFoundError('Member not found');
  }

  if (target.role === CORPORATE_MEMBER_ROLE.CORPORATE_OWNER) {
    const owners = await corporateRepository.countActiveOwners(membership.corporateAccountId);

    // Belt and braces: the count is checked even though only one owner should
    // exist, so a future ownership-transfer feature that briefly creates two
    // does not silently allow removing the last one (BR-222).
    if (owners <= 1) {
      throw new ForbiddenError('The last owner cannot be removed. Transfer ownership first.', {
        code: ERROR_CODES.LAST_OWNER_CANNOT_BE_REMOVED,
      });
    }
  }

  if (target.userId === actorUserId) {
    throw new BadRequestError('You cannot remove yourself from the company', {
      code: ERROR_CODES.CANNOT_REMOVE_SELF,
    });
  }

  const removed = await corporateRepository.removeMember({
    id: memberId,
    removedByUserId: actorUserId,
  });

  log.info(
    { corporateAccountId: membership.corporateAccountId, memberId, actorUserId },
    'corporate member removed'
  );

  return toPublicMember(removed);
};
