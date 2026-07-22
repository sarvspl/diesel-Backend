import { sendCreated, sendSuccess } from '../../shared/utils/api-response.js';

import * as addressService from './services/address.service.js';
import * as customerService from './services/customer.service.js';

/**
 * Thin HTTP layer. The caller's identity always comes from `req.auth`, never
 * from the request body or a path parameter (BR-225).
 */

/** POST /api/v1/customers/register */
export const registerCustomer = async (req, res) => {
  const profile = await customerService.registerCustomer({
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Customer profile created', data: { profile } });
};

/** GET /api/v1/customers/me */
export const getMe = async (req, res) => {
  const profile = await customerService.getCustomerProfile(req.auth.userId);

  return sendSuccess(res, { message: 'Customer profile retrieved', data: { profile } });
};

/** PATCH /api/v1/customers/me */
export const updateMe = async (req, res) => {
  const profile = await customerService.updateCustomerProfile({
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Customer profile updated', data: { profile } });
};

/** GET /api/v1/customers/addresses */
export const listAddresses = async (req, res) => {
  const addresses = await addressService.listAddresses(req.auth.userId);

  return sendSuccess(res, { message: 'Addresses retrieved', data: { addresses } });
};

/** POST /api/v1/customers/addresses */
export const createAddress = async (req, res) => {
  const address = await addressService.createAddress({
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Address created', data: { address } });
};

/** PATCH /api/v1/customers/addresses/:id */
export const updateAddress = async (req, res) => {
  const address = await addressService.updateAddress({
    id: req.validated.params.id,
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Address updated', data: { address } });
};

/**
 * DELETE /api/v1/customers/addresses/:id
 *
 * Archives rather than deletes, and returns 200 with a body rather than 204 -
 * the caller needs to know the row still exists for order history.
 */
export const deleteAddress = async (req, res) => {
  const result = await addressService.archiveAddress({
    id: req.validated.params.id,
    userId: req.auth.userId,
  });

  return sendSuccess(res, { message: 'Address removed', data: result });
};
