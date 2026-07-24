import { Router } from 'express';

import { PERMISSIONS, PRINCIPALS } from '../../shared/constants/rbac.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requirePermission, requirePrincipal } from '../../shared/middleware/authorize.js';
import { validate } from '../../shared/middleware/validate.js';

import * as controller from './corporate.controller.js';
import {
  addMemberSchema,
  memberIdSchema,
  registerCorporateSchema,
  updateMemberSchema,
} from './corporate.schema.js';

/**
 * Corporate self-service routes.
 *
 * No route here accepts a corporate id. The company is resolved from the
 * caller's membership every time, which is what makes cross-company access
 * structurally impossible rather than merely checked (BR-225).
 *
 * Member management carries TWO authorisation layers:
 *   `requirePermission(CORPORATE_MEMBER_MANAGE)` - may act on my own company
 *   member-role check inside the service           - may manage THIS company's members
 * The platform permission cannot express the second, because it varies per
 * company rather than per user.
 */
const router = Router();

router.use(authenticate, requirePrincipal(PRINCIPALS.CUSTOMER));

router.post(
  '/register',
  requirePermission(PERMISSIONS.CORPORATE_REGISTER),
  validate(registerCorporateSchema),
  controller.registerCorporate
);

/**
 * Re-apply after a rejection (BR-206).
 *
 * Behind CORPORATE_REGISTER, the same permission that created the company:
 * this is the same act, done again with corrected details.
 */
router.post(
  '/me/resubmit',
  requirePermission(PERMISSIONS.CORPORATE_REGISTER),
  validate(registerCorporateSchema),
  controller.resubmitCorporate
);

router.get('/me', requirePermission(PERMISSIONS.CORPORATE_READ_SELF), controller.getMyCorporate);

router.get('/members', requirePermission(PERMISSIONS.CORPORATE_READ_SELF), controller.listMembers);

router.post(
  '/members',
  requirePermission(PERMISSIONS.CORPORATE_MEMBER_MANAGE),
  validate(addMemberSchema),
  controller.addMember
);

router.patch(
  '/members/:id',
  requirePermission(PERMISSIONS.CORPORATE_MEMBER_MANAGE),
  validate(updateMemberSchema),
  controller.updateMember
);

router.delete(
  '/members/:id',
  requirePermission(PERMISSIONS.CORPORATE_MEMBER_MANAGE),
  validate(memberIdSchema),
  controller.removeMember
);

export default router;
