import { PrismaPg } from '@prisma/adapter-pg';

// Resolved via the "#prisma" subpath import in package.json, which points at
// the generated client. Application code never references the generated path
// directly, so regenerating or relocating it is a one-line change.
import { PrismaClient } from '#prisma';

import { env, isDevelopment } from '../../config/env.js';
import { createLogger } from '../../shared/logger/index.js';

const log = createLogger({ module: 'database' });

/**
 * Prisma 7 talks to PostgreSQL through a driver adapter rather than a bundled
 * Rust engine, which means the connection pool is ours to configure.
 */
const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  connectionTimeoutMillis: env.DATABASE_CONNECTION_TIMEOUT_MS,
});

/**
 * The single Prisma client for the process.
 *
 * One instance, one pool. Modules import this rather than constructing their
 * own — several clients would each open a pool and exhaust PostgreSQL's
 * connection limit under load.
 */
export const prisma = new PrismaClient({
  adapter,
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
    ...(isDevelopment ? [{ emit: 'event', level: 'query' }] : []),
  ],
});

prisma.$on('warn', (event) => log.warn({ target: event.target }, event.message));
prisma.$on('error', (event) => log.error({ target: event.target }, event.message));

if (isDevelopment) {
  // `event.query` is parameterised SQL ($1, $2, ...). `event.params` holds the
  // bound values and is deliberately NOT logged — it would contain password
  // hashes, OTPs and payment references.
  prisma.$on('query', (event) => {
    log.debug({ durationMs: event.duration, query: event.query }, 'prisma query');
  });
}

/**
 * Open the pool and prove the credentials work.
 *
 * Called once during startup so that a bad DATABASE_URL fails immediately and
 * visibly, rather than on the first request that happens to touch the database.
 */
export const connectDatabase = async () => {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;
  log.info('database connection established');
};

export const disconnectDatabase = async () => {
  await prisma.$disconnect();
  log.info('database connection closed');
};

/**
 * Liveness probe for the health endpoint.
 *
 * Raced against a timeout: a database that accepts the TCP connection but never
 * answers would otherwise hang the health check until the request times out,
 * which reads as "healthy but slow" to a load balancer instead of "unhealthy".
 *
 * Never throws. The failure reason is logged but deliberately NOT returned:
 * driver errors quote the host, port and user from the connection string
 * ("password authentication failed for user ...", "getaddrinfo ENOTFOUND ..."),
 * and the health endpoint is typically the least protected route on the API.
 *
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: 'up' | 'down', latencyMs: number }>}
 */
export const checkDatabaseHealth = async (timeoutMs = 2_000) => {
  const startedAt = process.hrtime.bigint();

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('database health check timed out')), timeoutMs);
  });

  try {
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return {
      status: 'up',
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    };
  } catch (error) {
    log.error({ err: error }, 'database health check failed');
    return {
      status: 'down',
      latencyMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
    };
  } finally {
    clearTimeout(timer);
  }
};
