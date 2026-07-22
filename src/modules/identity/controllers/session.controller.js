import { sendSuccess } from '../../../shared/utils/api-response.js';
import * as sessionService from '../services/session.service.js';

/** GET /api/v1/auth/sessions - the caller's active devices. */
export const listSessions = async (req, res) => {
  const sessions = await sessionService.listSessions(req.auth.userId);

  return sendSuccess(res, {
    message: 'Sessions retrieved',
    data: {
      sessions: sessions.map((session) => ({
        ...session,
        /** Lets the UI mark "this device" without exposing the token. */
        isCurrent: session.id === req.auth.sessionId,
      })),
    },
  });
};

/**
 * DELETE /api/v1/auth/sessions/:id - revoke one device.
 *
 * Scoped to the caller's own sessions by the ownership guard on the route. A
 * session belonging to someone else returns 404, not 403 (docs/10 §6).
 */
export const revokeSession = async (req, res) => {
  const result = await sessionService.revokeSession({
    sessionId: req.validated.params.id,
    userId: req.auth.userId,
    reason: 'LOGOUT',
  });

  return sendSuccess(res, { message: 'Session revoked', data: result });
};
