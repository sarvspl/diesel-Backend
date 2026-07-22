import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as customerRepository from '../repositories/customer.repository.js';

const log = createLogger({ module: 'customer.profile' });

/**
 * Customer profile lifecycle.
 *
 * Identity already exists by the time anything here runs: the caller
 * authenticated (by OTP or password) and holds a token. This module adds the
 * COMMERCIAL profile on top of that identity - it never creates users, never
 * touches credentials, and never duplicates a field that lives on `users`.
 */

/** Merge profile and identity into one client-facing shape. */
const toPublicProfile = (profile) => ({
  id: profile.id,
  userId: profile.userId,

  // From `users` - read, never stored here.
  phone: profile.user.phone,
  email: profile.user.email,
  phoneVerified: Boolean(profile.user.phoneVerifiedAt),
  emailVerified: Boolean(profile.user.emailVerifiedAt),
  accountStatus: profile.user.status,

  // The profile itself.
  fullName: profile.fullName,
  preferredLanguage: profile.preferredLanguage,
  profileImageKey: profile.profileImageKey,
  emergencyContact: {
    name: profile.emergencyContactName,
    phone: profile.emergencyContactPhone,
  },
  preferences: {
    marketingOptIn: profile.marketingOptIn,
    notifyByPush: profile.notifyByPush,
    notifyBySms: profile.notifyBySms,
    notifyByEmail: profile.notifyByEmail,
  },
  createdAt: profile.createdAt,
  updatedAt: profile.updatedAt,
});

/**
 * Create the calling user's customer profile.
 *
 * Not idempotent by design. A second call is a client bug (the app should read
 * `GET /customers/me` first), and silently returning the existing profile would
 * hide it while quietly discarding whatever the caller tried to set.
 */
export const registerCustomer = async ({ userId, ...input }) => {
  const existing = await customerRepository.findByUserId(userId);

  if (existing) {
    throw new ConflictError('A customer profile already exists for this account', {
      code: ERROR_CODES.PROFILE_ALREADY_EXISTS,
    });
  }

  const profile = await customerRepository.create({
    userId,
    fullName: input.fullName ?? null,
    preferredLanguage: input.preferredLanguage ?? 'en',
    emergencyContactName: input.emergencyContactName ?? null,
    emergencyContactPhone: input.emergencyContactPhone ?? null,
    marketingOptIn: input.marketingOptIn ?? false,
    // Timestamped so consent is provable, not just a boolean someone flipped
    // at an unknown moment (BR-1405, DPDP).
    marketingOptInAt: input.marketingOptIn ? new Date() : null,
    ...(input.notifyByPush === undefined ? {} : { notifyByPush: input.notifyByPush }),
    ...(input.notifyBySms === undefined ? {} : { notifyBySms: input.notifyBySms }),
    ...(input.notifyByEmail === undefined ? {} : { notifyByEmail: input.notifyByEmail }),
  });

  log.info({ userId, profileId: profile.id }, 'customer profile created');

  return toPublicProfile(profile);
};

export const getCustomerProfile = async (userId) => {
  const profile = await customerRepository.findByUserId(userId);

  if (!profile) {
    throw new NotFoundError('No customer profile exists for this account', {
      code: ERROR_CODES.PROFILE_NOT_FOUND,
    });
  }

  return toPublicProfile(profile);
};

/**
 * Patch the calling user's profile.
 *
 * Only the fields present in the request are written, so a client sending a
 * partial body cannot blank out values it did not mention.
 */
export const updateCustomerProfile = async ({ userId, ...input }) => {
  const existing = await customerRepository.findByUserId(userId);

  if (!existing) {
    throw new NotFoundError('No customer profile exists for this account', {
      code: ERROR_CODES.PROFILE_NOT_FOUND,
    });
  }

  const data = {};

  for (const field of [
    'fullName',
    'preferredLanguage',
    'profileImageKey',
    'emergencyContactName',
    'emergencyContactPhone',
    'notifyByPush',
    'notifyBySms',
    'notifyByEmail',
  ]) {
    if (input[field] !== undefined) data[field] = input[field];
  }

  // Consent changes are timestamped on transition only, so re-sending the same
  // value does not rewrite when it was given.
  if (input.marketingOptIn !== undefined && input.marketingOptIn !== existing.marketingOptIn) {
    data.marketingOptIn = input.marketingOptIn;
    data.marketingOptInAt = input.marketingOptIn ? new Date() : null;
  }

  const profile = await customerRepository.updateByUserId({ userId, data });

  return toPublicProfile(profile);
};
