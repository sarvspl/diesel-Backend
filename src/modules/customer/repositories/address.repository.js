import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Data access for delivery addresses.
 *
 * EVERY query is scoped by `userId`. There is deliberately no
 * `findById(id)` - a repository method that can return any user's address is
 * one forgotten controller check away from a data breach, so the capability
 * simply does not exist (BR-225, docs/11 §7.3).
 */

const PUBLIC_FIELDS = {
  id: true,
  nickname: true,
  line1: true,
  line2: true,
  landmark: true,
  city: true,
  state: true,
  pincode: true,
  latitude: true,
  longitude: true,
  googlePlaceId: true,
  deliveryInstructions: true,
  contactName: true,
  contactPhone: true,
  isDefault: true,
  isServiceable: true,
  serviceCheckedAt: true,
  createdAt: true,
  updatedAt: true,
};

/** Live addresses only. Archived rows stay for order history, not for lists. */
export const listForUser = async (userId) =>
  prisma.address.findMany({
    where: { userId, archivedAt: null },
    select: PUBLIC_FIELDS,
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });

export const findForUser = async ({ id, userId }) =>
  prisma.address.findFirst({
    where: { id, userId, archivedAt: null },
    select: PUBLIC_FIELDS,
  });

export const countForUser = async (userId) =>
  prisma.address.count({ where: { userId, archivedAt: null } });

/**
 * Create an address, maintaining the single-default invariant.
 *
 * Prisma cannot express a partial unique index (`unique(user_id) where
 * is_default and archived_at is null`), and adding one through raw SQL would
 * read as drift on the next `migrate dev`. So the invariant is held
 * transactionally: clear the other defaults and set this one inside a single
 * transaction, which serialises concurrent writes for the same user.
 */
export const createForUser = async ({ userId, makeDefault, ...data }) =>
  prisma.$transaction(async (tx) => {
    if (makeDefault) {
      await tx.address.updateMany({
        where: { userId, isDefault: true, archivedAt: null },
        data: { isDefault: false },
      });
    }

    return tx.address.create({
      data: { userId, isDefault: makeDefault, ...data },
      select: PUBLIC_FIELDS,
    });
  });

/**
 * Patch an address. Returns null when it does not belong to the caller, so the
 * service can answer 404 without ever having read another user's row.
 */
export const updateForUser = async ({ id, userId, makeDefault, data }) =>
  prisma.$transaction(async (tx) => {
    const owned = await tx.address.findFirst({
      where: { id, userId, archivedAt: null },
      select: { id: true },
    });

    if (!owned) return null;

    if (makeDefault) {
      await tx.address.updateMany({
        where: { userId, isDefault: true, archivedAt: null, id: { not: id } },
        data: { isDefault: false },
      });
    }

    return tx.address.update({
      where: { id },
      data: { ...data, ...(makeDefault === undefined ? {} : { isDefault: makeDefault }) },
      select: PUBLIC_FIELDS,
    });
  });

/**
 * Archive an address.
 *
 * Soft delete: orders will reference it, and a hard delete would orphan
 * delivery history (docs/08 §5). If the archived address was the default, the
 * most recently used remaining one is promoted - leaving a user with no default
 * silently breaks the ordering flow's "deliver to my usual place".
 */
export const archiveForUser = async ({ id, userId }) =>
  prisma.$transaction(async (tx) => {
    const target = await tx.address.findFirst({
      where: { id, userId, archivedAt: null },
      select: { id: true, isDefault: true },
    });

    if (!target) return null;

    await tx.address.update({
      where: { id },
      data: { archivedAt: new Date(), isDefault: false },
    });

    if (target.isDefault) {
      const next = await tx.address.findFirst({
        where: { userId, archivedAt: null, id: { not: id } },
        select: { id: true },
        orderBy: { updatedAt: 'desc' },
      });

      if (next) {
        await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }

    return { id, promotedDefaultId: null };
  });
