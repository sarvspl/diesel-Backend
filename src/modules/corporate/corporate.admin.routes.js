import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';

import * as controller from './corporate.controller.js';
import {
  approveCorporateSchema,
  changeAccountStatusSchema,
  corporateIdSchema,
  listCorporatesSchema,
  listPendingSchema,
  rejectCorporateSchema,
} from './corporate.schema.js';

/**
 * Administrative corporate review.
 *
 * Mounted under /admin and gated twice: the caller must hold an ADMIN-principal
 * token AND the `corporate.verify` permission. The principal check is not
 * redundant - it stops a customer token from ever reaching an admin route even
 * if a permission were mis-granted, which is the failure this defends against.
 *
 * `corporate.verify` is one of the highest-value permissions on the platform:
 * it decides who may trade. It belongs to SUPER_ADMIN and ADMIN only.
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.ADMIN));

/**
 * Literal paths BEFORE `/:id`, or `/pending` and `/counts` would be captured
 * as an id and fail UUID validation.
 */
router.get(
  '/pending',
  requirePermission(PERMISSIONS.CORPORATE_READ_ANY),
  validate(listPendingSchema),
  controller.listPending
);

router.get(
  '/counts',
  requirePermission(PERMISSIONS.CORPORATE_READ_ANY),
  controller.getCorporateCounts
);

/** The general directory: filterable on both status axes, searchable. */
router.get(
  '/',
  requirePermission(PERMISSIONS.CORPORATE_READ_ANY),
  validate(listCorporatesSchema),
  controller.listCorporates
);

/**
 * Full detail INCLUDING internal admin notes - the only projection that
 * exposes them. The corporate-facing endpoint deliberately omits the field.
 */
router.get(
  '/:id',
  requirePermission(PERMISSIONS.CORPORATE_READ_ANY),
  validate(corporateIdSchema),
  controller.getForReview
);

router.post(
  '/:id/approve',
  requirePermission(PERMISSIONS.CORPORATE_VERIFY),
  validate(approveCorporateSchema),
  controller.approveCorporate
);

router.post(
  '/:id/reject',
  requirePermission(PERMISSIONS.CORPORATE_VERIFY),
  validate(rejectCorporateSchema),
  controller.rejectCorporate
);

/**
 * Suspend and reactivate move the OPERATIONAL axis, not verification.
 *
 * Gated by `corporate.suspend`, NOT `corporate.verify`. They are different
 * decisions answering different questions - "is this a real company" versus
 * "may they operate today" - and docs/03 §4.4 grants them to different roles.
 * Reusing `corporate.verify` here would silently widen who can cut off a
 * paying customer.
 */
router.post(
  '/:id/suspend',
  requirePermission(PERMISSIONS.CORPORATE_SUSPEND),
  validate(changeAccountStatusSchema),
  controller.suspendCorporate
);

router.post(
  '/:id/reactivate',
  requirePermission(PERMISSIONS.CORPORATE_SUSPEND),
  validate(changeAccountStatusSchema),
  controller.reactivateCorporate
);

export default router;
