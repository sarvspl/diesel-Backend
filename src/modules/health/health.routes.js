import { Router } from 'express';

import { getHealth } from './health.controller.js';

const router = Router();

/**
 * GET /api/v1/health
 *
 * Unauthenticated and exempt from rate limiting (see rate-limit.js) so that
 * infrastructure probes are never throttled.
 */
router.get('/', getHealth);

export default router;
