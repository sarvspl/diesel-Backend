import { checkDatabaseHealth } from '../../infrastructure/database/prisma.js';

/**
 * Business logic for the health check.
 *
 * Kept out of the controller so that the readiness rule ("which dependencies
 * must be up for this instance to serve traffic?") lives in one place as Redis,
 * queues and external providers are added.
 */

/**
 * @returns {Promise<{ healthy: boolean, uptimeSeconds: number, timestamp: string,
 *                     dependencies: Record<string, { status: string, latencyMs: number }> }>}
 */
export const getHealthStatus = async () => {
  const database = await checkDatabaseHealth();

  const dependencies = { database };

  // An instance is healthy only if every dependency it needs to serve a request
  // is reachable. Future optional dependencies (cache, object storage) should
  // be reported here but must not flip `healthy` on their own.
  const healthy = Object.values(dependencies).every((dep) => dep.status === 'up');

  return {
    healthy,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    dependencies,
  };
};
