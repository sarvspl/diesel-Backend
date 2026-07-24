import { NotFoundError } from '../../../shared/errors/index.js';
import * as adminRepository from '../repositories/customer-admin.repository.js';

/**
 * Administrative customer queries.
 *
 * Read-only by design. Blocking a customer, adjusting a wallet or editing a
 * profile on their behalf are separate capabilities with their own permissions
 * (`user.block`, `customer.wallet.adjust`) and their own audit requirements;
 * none of them belong in a module whose job is "let an operator find someone
 * and see their account".
 */

/**
 * The company this customer orders for, flattened for the panel.
 *
 * Null for a retail buyer, which is the honest answer rather than an empty
 * object — "no company" and "a company with no name" are different things.
 *
 * The verification and account statuses come along because they are the whole
 * reason an operator cares: a corporate member whose company is still PENDING
 * cannot sign in at all, and that should be visible where the person is, not
 * only on the Corporate screen.
 */
const toCorporate = (profile) => {
  const membership = profile.user?.corporateMemberships?.[0];
  if (!membership?.corporateAccount) return null;

  const account = membership.corporateAccount;
  return {
    id: account.id,
    legalName: account.legalName,
    displayName: account.displayName ?? account.legalName,
    registration: {
      idType: account.registrationIdType,
      number: account.registrationNumber,
    },
    verificationStatus: account.verificationStatus,
    accountStatus: account.accountStatus,
    role: membership.role,
  };
};

/** Identity fields are flattened up, because a UI never wants `user.user.phone`. */
const toListItem = (profile) => {
  const corporate = toCorporate(profile);

  return {
    id: profile.id,
    userId: profile.userId,
    fullName: profile.fullName,
    phone: profile.user?.phone ?? null,
    email: profile.user?.email ?? null,
    status: profile.user?.status ?? null,
    phoneVerified: Boolean(profile.user?.phoneVerifiedAt),
    emailVerified: Boolean(profile.user?.emailVerifiedAt),
    lastLoginAt: profile.user?.lastLoginAt ?? null,
    registeredAt: profile.createdAt,
    // Stated explicitly rather than left for the client to infer from
    // `corporate == null`, so a list can label every row without a branch.
    accountType: corporate ? 'CORPORATE' : 'INDIVIDUAL',
    corporate,
  };
};

export const listCustomers = async ({ limit = 25, cursor, search, status, accountType } = {}) => {
  // Over-fetch by one to detect a further page without a second COUNT.
  const rows = await adminRepository.listCustomers({
    limit: limit + 1,
    cursor,
    search,
    status,
    accountType,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    customers: page.map(toListItem),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

export const getCustomer = async (id) => {
  const profile = await adminRepository.findCustomerById(id);

  if (!profile) {
    throw new NotFoundError('Customer not found');
  }

  const addresses = await adminRepository.listAddressesForUser(profile.userId);

  return {
    customer: {
      ...toListItem(profile),
      preferredLanguage: profile.preferredLanguage,
      emergencyContactName: profile.emergencyContactName,
      emergencyContactPhone: profile.emergencyContactPhone,
      marketingOptIn: profile.marketingOptIn,
      marketingOptInAt: profile.marketingOptInAt,
      notifyByPush: profile.notifyByPush,
      notifyBySms: profile.notifyBySms,
      notifyByEmail: profile.notifyByEmail,
      updatedAt: profile.updatedAt,
    },
    addresses,
  };
};
