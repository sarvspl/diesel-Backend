import { env } from '../../config/env.js';
import { ServiceUnavailableError } from '../../shared/errors/index.js';
import { sendSuccess } from '../../shared/utils/api-response.js';

import { getHealthStatus } from './health.service.js';

/**
 * GET /api/v1/health
 *
 * Reports API liveness and database connectivity.
 *
 * A degraded instance answers 503 so a load balancer takes it out of rotation.
 * That path throws rather than returning a body directly, so the response uses
 * the same error envelope as the rest of the API instead of the contradictory
 * "success: true with a 503 status".
 *
 * The payload names the environment and dependency states only — never the
 * database host, credentials or driver details.
 */
export const getHealth = async (_req, res) => {
  const { healthy, uptimeSeconds, timestamp, dependencies } = await getHealthStatus();

  const payload = {
    service: env.APP_NAME,
    environment: env.NODE_ENV,
    uptimeSeconds,
    timestamp,
    dependencies,
  };

  if (!healthy) {
    throw new ServiceUnavailableError('Service is degraded', {
      details: { ...payload, status: 'degraded' },
    });
  }

  return sendSuccess(res, {
    message: 'Service is healthy',
    data: { status: 'ok', ...payload },
  });
};
