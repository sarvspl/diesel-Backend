import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';

import * as controller from './pricing.controller.js';
import { createQuoteSchema, quoteIdSchema } from './pricing.schema.js';

/**
 * Customer-facing quotes.
 *
 * The ONLY pricing capability a customer has. `quote.create` lets them price an
 * order; it grants no visibility into products, rates, tax rules or price
 * history, which is what "customers may only generate quotes" means in practice.
 *
 * There is no GET /quotes list: a customer reads back a quote they were handed
 * an id for, scoped to themselves in the repository. Nothing here can enumerate
 * quotes, and nothing here returns a rate the caller did not just request.
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.CUSTOMER));

router.post(
  '/',
  requirePermission(PERMISSIONS.QUOTE_CREATE),
  validate(createQuoteSchema),
  controller.createQuote
);

router.get(
  '/:id',
  requirePermission(PERMISSIONS.QUOTE_CREATE),
  validate(quoteIdSchema),
  controller.getQuote
);

export default router;
