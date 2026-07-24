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

/**
 * The company this customer orders for, if any.
 *
 * An operator looking at a list of customers cannot otherwise tell a retail
 * buyer from someone ordering on a company account — they are the same row in
 * `customer_profiles`, and what separates them is a membership over in the
 * corporate module. Without this join the Customers screen can only show
 * everyone identically, which is exactly how a pending corporate applicant
 * looked like an ordinary signup.
 *
 * ACTIVE memberships only, and at most one: a removed member is soft-deleted so
 * order attribution survives (BR-223), and a person belongs to one company.
 */
const MEMBERSHIP_SELECT = {
  where: { status: 'ACTIVE' },
  take: 1,
  select: {
    role: true,
    corporateAccount: {
      select: {
        id: true,
        legalName: true,
        displayName: true,
        registrationIdType: true,
        registrationNumber: true,
        verificationStatus: true,
        accountStatus: true,
      },
    },
  },
};

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
      corporateMemberships: MEMBERSHIP_SELECT,
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
const buildWhere = ({ search, status, accountType }) => {
  const where = {};

  if (status) {
    where.user = { status };
  }

  // Retail buyer or company member. Expressed as the presence or absence of an
  // ACTIVE membership rather than a flag on the profile, so it cannot drift
  // from the membership that actually governs ordering and the login gate.
  if (accountType === 'CORPORATE' || accountType === 'INDIVIDUAL') {
    const membership = { some: { status: 'ACTIVE' } };
    where.user = {
      ...(where.user ?? {}),
      corporateMemberships: accountType === 'CORPORATE' ? membership : { none: { status: 'ACTIVE' } },
    };
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
export const listCustomers = async ({ limit, cursor, search, status, accountType }) =>
  prisma.customerProfile.findMany({
    where: buildWhere({ search, status, accountType }),
    select: LIST_FIELDS,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

export const countCustomers = async ({ search, status, accountType } = {}) =>
  prisma.customerProfile.count({ where: buildWhere({ search, status, accountType }) });

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

/**
 * The distinct places customers actually have addresses in.
 *
 * Feeds the pricing coverage check. "Is anything configured?" is the wrong
 * question — a deployment can hold prices for Kolkata and Pune and still refuse
 * every real order, because the addresses customers saved say Chakpachuria. The
 * only useful question is whether the places customers ARE can be priced.
 */
export const listServiceAreas = async () => {
  const rows = await prisma.address.groupBy({
    by: ['city', 'pincode'],
    where: { archivedAt: null },
    _count: { _all: true },
  });

  return rows
    .map((row) => ({ city: row.city, pincode: row.pincode, addressCount: row._count._all }))
    .sort((a, b) => b.addressCount - a.addressCount);
};

/** Registered since a moment - used by the dashboard's new-customer tile. */
export const countCustomersSince = async (since) =>
  prisma.customerProfile.count({ where: { createdAt: { gte: since } } });
