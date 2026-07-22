import { getServiceabilityProvider } from '../../../infrastructure/providers/serviceability/index.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { BadRequestError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as addressRepository from '../repositories/address.repository.js';

const log = createLogger({ module: 'customer.address' });

/**
 * Delivery address management.
 *
 * Ownership is enforced by SCOPING every query to the caller's user id rather
 * than by loading a row and comparing afterwards. The difference matters: with
 * scoping there is no code path that can return another user's address, so a
 * forgotten check cannot become a data breach (BR-225).
 *
 * A row belonging to someone else is therefore indistinguishable from one that
 * does not exist, and both answer 404 - a 403 would confirm the id is real
 * (docs/10 §6).
 */

/**
 * Guard against unbounded growth. Not a business rule from the docs; a
 * practical cap so one account cannot fill the table, and a round number a
 * genuine multi-site customer will not hit before corporate sites land (OQ-03).
 */
const MAX_ADDRESSES_PER_USER = 50;

/**
 * Ask the serviceability provider about a point.
 *
 * The answer is CACHED on the address for UI hinting only. BR-504 requires the
 * authoritative check at quote time, because zones and coverage change between
 * saving an address and ordering against it. Never gate saving on it: a
 * customer must be able to store an address the platform does not serve yet,
 * which is also how demand outside the current area gets measured (BR-505).
 */
const checkServiceability = async ({ latitude, longitude, pincode, city }) => {
  try {
    const result = await getServiceabilityProvider().check({ latitude, longitude, pincode, city });

    return { isServiceable: result.serviceable, serviceCheckedAt: new Date() };
  } catch (error) {
    // A provider outage must not block address creation.
    log.warn({ err: error }, 'serviceability check failed - saving address unchecked');
    return { isServiceable: null, serviceCheckedAt: null };
  }
};

export const listAddresses = async (userId) => addressRepository.listForUser(userId);

export const createAddress = async ({ userId, ...input }) => {
  const existingCount = await addressRepository.countForUser(userId);

  if (existingCount >= MAX_ADDRESSES_PER_USER) {
    throw new BadRequestError(
      `You can save at most ${MAX_ADDRESSES_PER_USER} addresses. Remove one first.`,
      { code: ERROR_CODES.ADDRESS_LIMIT_REACHED }
    );
  }

  const serviceability = await checkServiceability(input);

  const address = await addressRepository.createForUser({
    userId,
    // The first address a user saves becomes their default automatically -
    // otherwise the ordering flow has nothing to preselect.
    makeDefault: input.isDefault === true || existingCount === 0,
    nickname: input.nickname ?? null,
    line1: input.line1,
    line2: input.line2 ?? null,
    landmark: input.landmark ?? null,
    city: input.city,
    state: input.state,
    pincode: input.pincode,
    latitude: input.latitude,
    longitude: input.longitude,
    googlePlaceId: input.googlePlaceId ?? null,
    deliveryInstructions: input.deliveryInstructions ?? null,
    contactName: input.contactName ?? null,
    contactPhone: input.contactPhone ?? null,
    ...serviceability,
  });

  log.info({ userId, addressId: address.id }, 'address created');

  return address;
};

export const updateAddress = async ({ id, userId, ...input }) => {
  const data = {};

  for (const field of [
    'nickname',
    'line1',
    'line2',
    'landmark',
    'city',
    'state',
    'pincode',
    'googlePlaceId',
    'deliveryInstructions',
    'contactName',
    'contactPhone',
  ]) {
    if (input[field] !== undefined) data[field] = input[field];
  }

  // Moving the pin invalidates the cached serviceability answer, so re-check
  // rather than leaving a stale verdict attached to a different location.
  if (input.latitude !== undefined && input.longitude !== undefined) {
    data.latitude = input.latitude;
    data.longitude = input.longitude;
    Object.assign(
      data,
      await checkServiceability({
        latitude: input.latitude,
        longitude: input.longitude,
        pincode: input.pincode ?? undefined,
        city: input.city ?? undefined,
      })
    );
  }

  const address = await addressRepository.updateForUser({
    id,
    userId,
    // `false` is ignored deliberately: un-defaulting without choosing a
    // replacement would leave the user with no default at all. To change the
    // default, set it on the address that should become one.
    makeDefault: input.isDefault === true ? true : undefined,
    data,
  });

  if (!address) {
    throw new NotFoundError('Address not found');
  }

  return address;
};

export const archiveAddress = async ({ id, userId }) => {
  const result = await addressRepository.archiveForUser({ id, userId });

  if (!result) {
    throw new NotFoundError('Address not found');
  }

  log.info({ userId, addressId: id }, 'address archived');

  return { id, archived: true };
};
