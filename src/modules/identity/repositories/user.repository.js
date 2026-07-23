import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Data access for identities.
 *
 * The ONLY place in the identity module that touches Prisma for users
 * (docs/11 §1.3). Services call these; controllers never do.
 *
 * `passwordHash` is deliberately excluded from every projection except
 * `findByIdentifierForAuth`, so a hash cannot leak into a response by someone
 * forgetting to strip it.
 */

/** Fields safe to return from an API. Note the absence of `passwordHash`. */
const PUBLIC_FIELDS = {
  id: true,
  principal: true,
  phone: true,
  email: true,
  status: true,
  phoneVerifiedAt: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
};

const WITH_ROLES = {
  ...PUBLIC_FIELDS,
  roles: {
    select: {
      role: {
        select: {
          code: true,
          name: true,
          permissions: { select: { permission: { select: { code: true } } } },
        },
      },
    },
  },
};

/**
 * Flatten the nested role/permission join into plain arrays.
 *
 * Kept here rather than in the service because the nesting is an artefact of
 * how the data is stored, not something the domain should know about.
 *
 * @returns {{ roles: string[], permissions: string[] }}
 */
export const flattenAuthorisation = (user) => {
  const roles = [];
  const permissions = new Set();

  for (const { role } of user.roles ?? []) {
    roles.push(role.code);
    for (const { permission } of role.permissions ?? []) {
      permissions.add(permission.code);
    }
  }

  return { roles, permissions: [...permissions].sort() };
};

/**
 * Look up a candidate for authentication by phone or email within a principal.
 *
 * This is the one query that returns `passwordHash`. It is scoped by principal
 * because the same phone may belong to a customer and a driver (BR-104), and
 * an admin-app login must never match a customer record.
 */
export const findByIdentifierForAuth = async ({ principal, phone, email }) => {
  const where = phone
    ? { phone_principal: { phone, principal } }
    : { email_principal: { email, principal } };

  return prisma.user.findUnique({
    where,
    select: { ...WITH_ROLES, passwordHash: true },
  });
};

export const findByIdWithRoles = async (id) =>
  prisma.user.findUnique({ where: { id }, select: WITH_ROLES });

/**
 * Record that the phone was proven, if it was not already.
 *
 * Conditional on `phoneVerifiedAt` being null so the ORIGINAL verification
 * time is preserved - overwriting it on every OTP login would lose the only
 * record of when the number was first proven.
 */
export const markPhoneVerified = async (id) => {
  const { count } = await prisma.user.updateMany({
    where: { id, phoneVerifiedAt: null },
    data: { phoneVerifiedAt: new Date() },
  });

  return count;
};

/**
 * Create an identity and grant its default role atomically.
 *
 * Both must happen or neither: a user with no role can authenticate but can do
 * nothing, which is a confusing half-state to debug.
 */
/**
 * The same write, against a caller-supplied client.
 *
 * Exists because onboarding a driver creates an identity AND an employment
 * profile, and half of that is worse than neither: a user with no profile
 * cannot be dispatched but occupies the phone number, so the operator cannot
 * simply try again. The caller passes its transaction and gets both or nothing.
 */
export const createWithRoleIn = async (
  client,
  { principal, phone, email, passwordHash, roleCode, consentVersion, phoneVerified = false }
) =>
  client.user.create({
    data: {
      principal,
      phone: phone ?? null,
      email: email ?? null,
      passwordHash: passwordHash ?? null,
      phoneVerifiedAt: phoneVerified ? new Date() : null,
      consentVersion: consentVersion ?? null,
      consentAt: consentVersion ? new Date() : null,
      roles: {
        create: {
          role: { connect: { code: roleCode } },
        },
      },
    },
    select: WITH_ROLES,
  });

export const createWithRole = async ({
  principal,
  phone,
  email,
  passwordHash,
  roleCode,
  consentVersion,
  phoneVerified = false,
}) =>
  // A single nested write. Prisma runs nested creates in one implicit
  // transaction, so wrapping this in $transaction added a round trip and no
  // guarantee - removed.
  prisma.user.create({
    data: {
      principal,
      phone: phone ?? null,
      email: email ?? null,
      passwordHash: passwordHash ?? null,
      phoneVerifiedAt: phoneVerified ? new Date() : null,
      consentVersion: consentVersion ?? null,
      consentAt: consentVersion ? new Date() : null,
      roles: {
        create: {
          role: { connect: { code: roleCode } },
        },
      },
    },
    select: WITH_ROLES,
  });

export const touchLastLogin = async (id) =>
  prisma.user.update({
    where: { id },
    data: { lastLoginAt: new Date() },
    select: { id: true },
  });
