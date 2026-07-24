import { sendCreated, sendSuccess } from '../../shared/utils/api-response.js';

import * as corporateService from './services/corporate.service.js';
import * as memberService from './services/member.service.js';
import * as verificationService from './services/verification.service.js';

/**
 * Thin HTTP layer.
 *
 * The company a request acts on is ALWAYS resolved from the caller's
 * membership, never from a path parameter or body field. There is no endpoint
 * on this router that takes a corporate id (BR-225).
 */

/** POST /api/v1/corporates/register */
export const registerCorporate = async (req, res) => {
  const result = await corporateService.registerCorporate({
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Corporate registration submitted', data: result });
};

/**
 * POST /api/v1/corporates/me/resubmit
 *
 * 200, not 201: the company already exists. This corrects it and puts it back
 * in the queue (BR-206).
 */
export const resubmitCorporate = async (req, res) => {
  const result = await corporateService.resubmitCorporate({
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Registration resubmitted for review', data: result });
};

/** GET /api/v1/corporates/me */
export const getMyCorporate = async (req, res) => {
  const result = await corporateService.getMyCorporate(req.auth.userId);

  return sendSuccess(res, { message: 'Corporate account retrieved', data: result });
};

/** GET /api/v1/corporates/members */
export const listMembers = async (req, res) => {
  const membership = await corporateService.resolveActiveMembership(req.auth.userId);
  const members = await memberService.listMembers({ membership });

  return sendSuccess(res, { message: 'Members retrieved', data: { members } });
};

/** POST /api/v1/corporates/members */
export const addMember = async (req, res) => {
  const membership = await corporateService.resolveActiveMembership(req.auth.userId);

  const member = await memberService.addMember({
    membership,
    actorUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Member added', data: { member } });
};

/** PATCH /api/v1/corporates/members/:id */
export const updateMember = async (req, res) => {
  const membership = await corporateService.resolveActiveMembership(req.auth.userId);

  const member = await memberService.updateMemberRole({
    membership,
    memberId: req.validated.params.id,
    role: req.validated.body.role,
  });

  return sendSuccess(res, { message: 'Member updated', data: { member } });
};

/** DELETE /api/v1/corporates/members/:id */
export const removeMember = async (req, res) => {
  const membership = await corporateService.resolveActiveMembership(req.auth.userId);

  const member = await memberService.removeMember({
    membership,
    actorUserId: req.auth.userId,
    memberId: req.validated.params.id,
  });

  return sendSuccess(res, { message: 'Member removed', data: { member } });
};

// --- Admin -----------------------------------------------------------------

/** GET /api/v1/admin/corporates/pending */
export const listPending = async (req, res) => {
  const result = await verificationService.listPending(req.validated.query);

  return sendSuccess(res, { message: 'Pending corporate registrations retrieved', data: result });
};

/** GET /api/v1/admin/corporates */
export const listCorporates = async (req, res) => {
  const result = await verificationService.listCorporates(req.validated.query);

  return sendSuccess(res, { message: 'Corporate accounts retrieved', data: result });
};

/** GET /api/v1/admin/corporates/counts */
export const getCorporateCounts = async (_req, res) => {
  const counts = await verificationService.countsByVerification();

  return sendSuccess(res, { message: 'Corporate counts retrieved', data: { counts } });
};

/** POST /api/v1/admin/corporates/:id/suspend */
export const suspendCorporate = async (req, res) => {
  const account = await verificationService.suspend({
    corporateAccountId: req.validated.params.id,
    reviewerUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Corporate account suspended', data: { account } });
};

/** POST /api/v1/admin/corporates/:id/reactivate */
export const reactivateCorporate = async (req, res) => {
  const account = await verificationService.reactivate({
    corporateAccountId: req.validated.params.id,
    reviewerUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Corporate account reactivated', data: { account } });
};

/** GET /api/v1/admin/corporates/:id */
export const getForReview = async (req, res) => {
  const result = await verificationService.getForReview(req.validated.params.id);

  return sendSuccess(res, { message: 'Corporate account retrieved', data: result });
};

/** POST /api/v1/admin/corporates/:id/approve */
export const approveCorporate = async (req, res) => {
  const account = await verificationService.approve({
    corporateAccountId: req.validated.params.id,
    reviewerUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Corporate registration approved', data: { account } });
};

/** POST /api/v1/admin/corporates/:id/reject */
export const rejectCorporate = async (req, res) => {
  const account = await verificationService.reject({
    corporateAccountId: req.validated.params.id,
    reviewerUserId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Corporate registration rejected', data: { account } });
};
