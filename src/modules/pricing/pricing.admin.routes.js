import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';
import { sendSuccess } from '../../shared/utils/api-response.js';

import * as controller from './pricing.controller.js';
import * as coverageService from './services/coverage.service.js';
import {
  createDeliveryChargeSchema,
  createPriceSchema,
  createProductSchema,
  createTaxSchema,
  listDeliveryChargesSchema,
  listPricesSchema,
  listProductsSchema,
  listTaxesSchema,
  pushFyftRateSchema,
  updatePriceStatusSchema,
  updateProductSchema,
  updateTaxSchema,
} from './pricing.schema.js';

/**
 * Pricing administration.
 *
 * ADMIN principal on every route: "Only Admins manage pricing." A customer
 * token cannot reach any of these even if a permission were mis-granted during
 * a role edit, because the principal check fails first.
 *
 * Read and write are separate grants throughout. Viewing price history is
 * ordinary operations work; publishing a rate moves real money on every
 * subsequent order.
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.ADMIN));

// --- Products --------------------------------------------------------------

router.get(
  '/products',
  requirePermission(PERMISSIONS.PRODUCT_READ),
  validate(listProductsSchema),
  controller.listProducts
);

router.post(
  '/products',
  requirePermission(PERMISSIONS.PRODUCT_MANAGE),
  validate(createProductSchema),
  controller.createProduct
);

router.patch(
  '/products/:id',
  requirePermission(PERMISSIONS.PRODUCT_MANAGE),
  validate(updateProductSchema),
  controller.updateProduct
);

// --- Prices ----------------------------------------------------------------

/**
 * GET /api/v1/admin/coverage
 *
 * Whether the places customers actually have addresses in can be priced. Read
 * with `price.read` because that is the configuration it reports on.
 */
router.get('/coverage', requirePermission(PERMISSIONS.PRICE_READ), async (_req, res) => {
  const result = await coverageService.getCoverage();
  return sendSuccess(res, { message: 'Pricing coverage retrieved', data: result });
});

router.get(
  '/prices',
  requirePermission(PERMISSIONS.PRICE_READ),
  validate(listPricesSchema),
  controller.listPrices
);

router.post(
  '/prices',
  requirePermission(PERMISSIONS.PRICE_MANAGE),
  validate(createPriceSchema),
  controller.publishPrice
);

/**
 * Activating a price that was parked outside the sanity band needs
 * `price.approve` AS WELL, and the approver must not be the author. Both are
 * enforced in the service rather than here: the second check depends on the
 * row, which middleware has not loaded (BR-607, docs/03 §4.4).
 *
 * `price.manage` is the floor for the ordinary transitions (draft, cancel).
 */
router.patch(
  '/prices/:id/status',
  requirePermission(PERMISSIONS.PRICE_MANAGE),
  validate(updatePriceStatusSchema),
  controller.updatePriceStatus
);

// --- Tax rules -------------------------------------------------------------

router.get(
  '/taxes',
  requirePermission(PERMISSIONS.TAX_READ),
  validate(listTaxesSchema),
  controller.listTaxRules
);

router.post(
  '/taxes',
  requirePermission(PERMISSIONS.TAX_MANAGE),
  validate(createTaxSchema),
  controller.createTaxRule
);

router.patch(
  '/taxes/:id',
  requirePermission(PERMISSIONS.TAX_MANAGE),
  validate(updateTaxSchema),
  controller.updateTaxRule
);

// --- Delivery charges ------------------------------------------------------

router.get(
  '/delivery-charges',
  requirePermission(PERMISSIONS.DELIVERY_CHARGE_READ),
  validate(listDeliveryChargesSchema),
  controller.listDeliveryRules
);

router.post(
  '/delivery-charges',
  requirePermission(PERMISSIONS.DELIVERY_CHARGE_MANAGE),
  validate(createDeliveryChargeSchema),
  controller.createDeliveryRule
);

// --- FYFT device rate ------------------------------------------------------

/**
 * Push our HSD rate to the FYFT device platform (display-only on their side).
 * `price.manage` — it is a rate action, though it never touches customer
 * pricing; a mis-configured server answers 503 rather than failing silently.
 */
router.post(
  '/fyft-rate',
  requirePermission(PERMISSIONS.PRICE_MANAGE),
  validate(pushFyftRateSchema),
  controller.pushFyftRate
);

export default router;
