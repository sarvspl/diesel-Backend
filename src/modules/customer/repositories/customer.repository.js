import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Data access for customer profiles.
 *
 * Reads the linked `users` row for identity fields rather than copying them:
 * phone, email and verification state have exactly one home (docs/05 §2).
 */

const PROFILE_FIELDS = {
  id: true,
  userId: true,
  fullName: true,
  preferredLanguage: true,
  profileImageKey: true,
  emergencyContactName: true,
  emergencyContactPhone: true,
  marketingOptIn: true,
  marketingOptInAt: true,
  notifyByPush: true,
  notifyBySms: true,
  notifyByEmail: true,
  createdAt: true,
  updatedAt: true,
};

/** Identity fields joined for display. Never includes `passwordHash`. */
const WITH_IDENTITY = {
  ...PROFILE_FIELDS,
  user: {
    select: {
      id: true,
      principal: true,
      phone: true,
      email: true,
      status: true,
      phoneVerifiedAt: true,
      emailVerifiedAt: true,
    },
  },
};

export const findByUserId = async (userId) =>
  prisma.customerProfile.findUnique({ where: { userId }, select: WITH_IDENTITY });

export const create = async ({ userId, ...data }) =>
  prisma.customerProfile.create({
    data: { userId, ...data },
    select: WITH_IDENTITY,
  });

/**
 * Patch a profile.
 *
 * Scoped by `userId`, not by profile id: a caller cannot reach another
 * customer's profile even if they supply its id, because no query accepts one
 * (BR-225).
 */
export const updateByUserId = async ({ userId, data }) =>
  prisma.customerProfile.update({ where: { userId }, data, select: WITH_IDENTITY });
