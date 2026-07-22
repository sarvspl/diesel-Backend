import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Administrative reads over customer profiles.
 *
 * Separate from `customer.repository.js` on purpose. That repository scopes
 * every query to `userId` precisely so no query exists that could return
 * another customer's data (BR-225) - which is a property worth keeping. These
 * queries are deliberately cross-customer, so they live apart and are reachable
 * only from the admin router behind `customer.read.any`.
 */

const LIST_FIELDS = {
  id: true,
  userId: true,
  fullName: true,
  createdAt: true,
  user: {
    select: {
      id: true,
      phone: true,
      email: true,
      status: true,
      phoneVerifiedAt: true,
      emailVerifiedAt: true,
      lastLoginAt: true,
      createdAt: true,
    },
  },
};

const DETAIL_FIELDS = {
  ...LIST_FIELDS,
  preferredLanguage: true,
  emergencyContactName: true,
  emergencyContactPhone: true,
  marketingOptIn: true,
  marketingOptInAt: true,
  notifyByPush: true,
  notifyBySms: true,
  notifyByEmail: true,
  updatedAt: true,
};

/**
 * Search across name, phone and email.
 *
 * `mode: 'insensitive'` on name only - phone and email are already stored
 * normalised, and a case-insensitive match on them would forfeit the index.
 */
const buildWhere = ({ search, status }) => {
  const where = {};

  if (status) {
    where.user = { status };
  }

  if (search) {
    const term = search.trim();
    where.OR = [
      { fullName: { contains: term, mode: 'insensitive' } },
      { user: { phone: { contains: term } } },
      { user: { email: { contains: term.toLowerCase() } } },
    ];
  }

  return where;
};

/**
 * Cursor-paginated list.
 *
 * Cursor, not offset (docs/10 §9.1): offset pagination skips or duplicates rows
 * when the underlying data changes between pages. Ordered by `createdAt desc`
 * with `id` as a tiebreaker, because two customers can register in the same
 * millisecond and an unstable sort makes the cursor meaningless.
 */
export const listCustomers = async ({ limit, cursor, search, status }) =>
  prisma.customerProfile.findMany({
    where: buildWhere({ search, status }),
    select: LIST_FIELDS,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

export const countCustomers = async ({ search, status } = {}) =>
  prisma.customerProfile.count({ where: buildWhere({ search, status }) });

export const findCustomerById = async (id) =>
  prisma.customerProfile.findUnique({ where: { id }, select: DETAIL_FIELDS });

/**
 * Addresses for a customer. Admin-scoped; the customer path uses its own.
 *
 * Archived rows are excluded: they are soft-deleted, not history worth showing
 * an operator by default. Orders snapshot their address anyway (BR-805), so an
 * archived row is never needed to explain a past delivery.
 */
export const listAddressesForUser = async (userId) =>
  prisma.address.findMany({
    where: { userId, archivedAt: null },
    select: {
      id: true,
      nickname: true,
      line1: true,
      line2: true,
      landmark: true,
      city: true,
      state: true,
      pincode: true,
      deliveryInstructions: true,
      contactName: true,
      contactPhone: true,
      isDefault: true,
      isServiceable: true,
      serviceCheckedAt: true,
      createdAt: true,
    },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });

/** Registered since a moment - used by the dashboard's new-customer tile. */
export const countCustomersSince = async (since) =>
  prisma.customerProfile.count({ where: { createdAt: { gte: since } } });
