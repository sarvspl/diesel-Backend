import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';
import { sendSuccess } from '../../shared/utils/api-response.js';

import { customerIdSchema, listCustomersSchema } from './customer.admin.schema.js';
import * as adminService from './services/customer-admin.service.js';

/**
 * Administrative customer directory.
 *
 * Read-only. The customer-facing router next door is scoped to `/me` and
 * carries `requirePrincipal(CUSTOMER)`, which means an administrator cannot
 * reach it at all - deliberately, because those queries are written to be
 * incapable of returning another user's row (BR-225). Cross-customer reads
 * therefore need their own surface, and this is it, behind `customer.read.any`.
 *
 * ADMIN principal plus a per-route permission, matching every other admin
 * router: the principal check stops a customer token reaching an admin route
 * even if a permission were mis-granted during a role edit.
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.ADMIN));

/** GET /api/v1/admin/customers */
router.get(
  '/',
  requirePermission(PERMISSIONS.CUSTOMER_READ_ANY),
  validate(listCustomersSchema),
  async (req, res) => {
    const result = await adminService.listCustomers(req.validated.query);
    return sendSuccess(res, { message: 'Customers retrieved', data: result });
  }
);

/** GET /api/v1/admin/customers/:id */
router.get(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMER_READ_ANY),
  validate(customerIdSchema),
  async (req, res) => {
    const result = await adminService.getCustomer(req.validated.params.id);
    return sendSuccess(res, { message: 'Customer retrieved', data: result });
  }
);

export default router;
