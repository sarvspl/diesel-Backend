import { Router } from 'express';

import { PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePrincipal } from '../../shared/middleware/authorize.js';
import { sendSuccess } from '../../shared/utils/api-response.js';

import * as catalogService from './services/catalog.service.js';

/**
 * The customer-facing catalogue.
 *
 * Read-only, and separate from `pricing.admin.routes.js` because the two answer
 * different questions. The admin listing is the catalogue as MANAGED — every
 * product including archived ones, with display order and audit columns. This
 * is the catalogue as OFFERED: what a customer may order right now.
 *
 * No per-route permission beyond being a signed-in customer. Every customer may
 * see what is for sale; there is nothing here to scope to an individual, and a
 * permission would only be a second name for "is a customer".
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.CUSTOMER));

/** GET /api/v1/products */
router.get('/', async (_req, res) => {
  const result = await catalogService.listOrderableProducts();
  return sendSuccess(res, { message: 'Products retrieved', data: result });
});

export default router;
