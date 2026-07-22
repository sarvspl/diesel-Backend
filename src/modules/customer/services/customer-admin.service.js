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

/** Identity fields are flattened up, because a UI never wants `user.user.phone`. */
const toListItem = (profile) => ({
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
});

export const listCustomers = async ({ limit = 25, cursor, search, status } = {}) => {
  // Over-fetch by one to detect a further page without a second COUNT.
  const rows = await adminRepository.listCustomers({
    limit: limit + 1,
    cursor,
    search,
    status,
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
