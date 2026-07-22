import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';

import * as controller from './customer.controller.js';
import {
  addressIdSchema,
  createAddressSchema,
  registerCustomerSchema,
  updateAddressSchema,
  updateCustomerSchema,
} from './customer.schema.js';

/**
 * Customer routes.
 *
 * Every route is authenticated: a customer profile hangs off an identity that
 * must already exist. There is no unauthenticated customer registration -
 * `POST /auth/otp/verify` creates the identity, and this creates the profile.
 *
 * `requirePrincipal(CUSTOMER)` is surface separation, not authorisation: a
 * driver token must not reach customer endpoints even if the permissions
 * happened to overlap (ADR-016).
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.CUSTOMER));

router.post(
  '/register',
  requirePermission(PERMISSIONS.CUSTOMER_UPDATE_SELF),
  validate(registerCustomerSchema),
  controller.registerCustomer
);

router.get('/me', requirePermission(PERMISSIONS.CUSTOMER_READ_SELF), controller.getMe);

router.patch(
  '/me',
  requirePermission(PERMISSIONS.CUSTOMER_UPDATE_SELF),
  validate(updateCustomerSchema),
  controller.updateMe
);

// --- Addresses -------------------------------------------------------------
// Ownership is enforced inside the repository by scoping every query to the
// authenticated user, which is stronger than a middleware check: no query
// exists that could return another user's address.

router.get(
  '/addresses',
  requirePermission(PERMISSIONS.ADDRESS_MANAGE_SELF),
  controller.listAddresses
);

router.post(
  '/addresses',
  requirePermission(PERMISSIONS.ADDRESS_MANAGE_SELF),
  validate(createAddressSchema),
  controller.createAddress
);

router.patch(
  '/addresses/:id',
  requirePermission(PERMISSIONS.ADDRESS_MANAGE_SELF),
  validate(updateAddressSchema),
  controller.updateAddress
);

router.delete(
  '/addresses/:id',
  requirePermission(PERMISSIONS.ADDRESS_MANAGE_SELF),
  validate(addressIdSchema),
  controller.deleteAddress
);

export default router;
