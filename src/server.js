import { createApp, API_V1_PREFIX } from './app.js';
import { env, isProduction } from './config/env.js';
import { findPendingMigrations } from './infrastructure/database/migration-status.js';
import { connectDatabase, disconnectDatabase } from './infrastructure/database/prisma.js';
import { beginShutdown } from './shared/lifecycle.js';
import { logger } from './shared/logger/index.js';

/** @type {import('node:http').Server | undefined} */
let server;

/**
 * Boot sequence.
 *
 * The database is verified BEFORE the port is bound. An instance that cannot
 * reach PostgreSQL must never enter the load balancer's rotation and start
 * failing real requests — better to crash now and let the orchestrator retry.
 */
const start = async () => {
  await connectDatabase();

  // A schema behind the code is invisible until the first write 500s at a real
  // customer. Said once, loudly, at the only moment anyone is watching a deploy.
  //
  // Logged rather than fatal ON PURPOSE: some pipelines run migrations as a
  // release step that follows the container starting, and refusing to boot
  // would turn "one endpoint is broken" into "the site is down". The remedy is
  // in the message so nobody has to go and look it up.
  const migrations = await findPendingMigrations();

  if (migrations.pending.length > 0) {
    logger.error(
      { pendingMigrations: migrations.pending },
      'DATABASE SCHEMA IS OUT OF DATE: writes touching new columns will fail with a 500. Run `npx prisma migrate deploy` and restart'
    );
  }

  // Impossible to miss in a terminal, and impossible to explain away in a log.
  // Deliberately `error` level in production: on a public host this is not a
  // note, it is the single most important fact about the deployment.
  if (env.OTP_INSECURE_FIXED_CODE) {
    const announce = isProduction ? logger.error : logger.warn;

    announce.call(
      logger,
      { otpFixedCode: env.OTP_INSECURE_FIXED_CODE, nodeEnv: env.NODE_ENV },
      'AUTHENTICATION BYPASS ACTIVE: every OTP is this fixed code, so anyone who knows a phone number can sign in as that user. Unset OTP_INSECURE_FIXED_CODE before this serves real customers'
    );
  }

  const app = createApp();

  server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      {
        host: env.HOST,
        port: env.PORT,
        nodeEnv: env.NODE_ENV,
        healthCheck: `${API_V1_PREFIX}/health`,
      },
      'server listening'
    );
  });

  // Must exceed the idle timeout of any upstream load balancer (AWS ALB
  // defaults to 60s). If Node closes a keep-alive socket first, the balancer
  // can send a request into a connection that is already going away and the
  // client sees a spurious 502.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
};

/**
 * Graceful shutdown.
 *
 * 1. Flip the lifecycle flag so new requests get 503 instead of being accepted.
 * 2. Stop the listener and let in-flight requests finish.
 * 3. Close idle keep-alive sockets, which would otherwise hold the server open
 *    for the full drain window with no work left to do.
 * 4. Release the database pool.
 *
 * Guarded against re-entry: a second SIGINT (an impatient Ctrl+C) must not
 * start a second drain and race the first.
 *
 * @param {string} reason
 * @param {number} [exitCode]
 */
const shutdown = async (reason, exitCode = 0) => {
  if (!beginShutdown()) {
    logger.warn({ reason }, 'shutdown already in progress, ignoring');
    return;
  }

  logger.info({ reason, timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'graceful shutdown started');

  // Backstop: never hang forever on a stuck connection.
  const forceExit = setTimeout(() => {
    logger.fatal('graceful shutdown timed out, forcing exit');
    server?.closeAllConnections?.();
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);

  // Do not let this timer keep an otherwise-finished process alive.
  forceExit.unref();

  try {
    if (server?.listening) {
      const closed = new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });

      // Called AFTER close() is initiated but BEFORE awaiting it: close() stops
      // accepting new connections but waits on existing ones, and idle
      // keep-alive sockets would never resolve it on their own.
      server.closeIdleConnections?.();

      await closed;
      logger.info('http server closed');
    }

    await disconnectDatabase();

    clearTimeout(forceExit);
    logger.info({ reason }, 'shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    exitCode = 1;
  }

  // Give the pino transport a chance to drain before the process disappears.
  logger.flush?.();
  process.exit(exitCode);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// The process is in an undefined state after either of these. Log, drain what
// we can, and exit non-zero so the supervisor restarts a clean instance.
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});

start().catch((error) => {
  logger.fatal({ err: error }, 'failed to start server');
  logger.flush?.();
  process.exit(1);
});
