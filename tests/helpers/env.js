/**
 * Test environment bootstrap.
 *
 * MUST be imported before anything that reaches config/env.js, because that
 * module validates and freezes configuration at import time and exits the
 * process if it is invalid.
 *
 * Argon2 cost is lowered deliberately: production parameters take ~100ms per
 * hash by design, which would make the password tests take minutes. The
 * algorithm under test is identical; only the work factor changes.
 */
import { config } from 'dotenv';

/**
 * TEST_DATABASE_URL is read from .env, and NOTHING else is.
 *
 * The integration suites skip silently when it is unset, so a developer who
 * put it in .env and never exported it would watch 118 tests quietly not run
 * and read the green summary as a pass.
 *
 * Parsed into a scratch object rather than loaded into `process.env`, because
 * a plain `dotenv/config` here would also import the DEVELOPMENT
 * DATABASE_URL - and the integration suites delete rows.
 */
if (!process.env.TEST_DATABASE_URL) {
  const parsed = {};
  config({ processEnv: parsed, quiet: true });

  if (parsed.TEST_DATABASE_URL) process.env.TEST_DATABASE_URL = parsed.TEST_DATABASE_URL;
}

process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.DATABASE_URL ??=
  'postgresql://test:test@localhost:5432/diesel_for_you_test?schema=public';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-not-used-in-any-real-deployment-0001';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-not-used-in-any-real-deployment-002';
process.env.ARGON2_MEMORY_COST_KIB ??= '8192';
process.env.ARGON2_TIME_COST ??= '2';

/**
 * Anti-abuse limits are raised for integration runs.
 *
 * The whole suite drives one process from 127.0.0.1 and reuses a handful of
 * phone numbers, so production-sized limits reject legitimate test traffic —
 * the limiter doing exactly its job, against the wrong adversary.
 *
 * Safe to raise here because the limits have their OWN coverage: the wiring
 * checks assert a 429 at the configured boundary, and the OTP cooldown is
 * asserted explicitly in the integration suite. Raising them lets the other
 * tests exercise business flows rather than the rate limiter.
 */
process.env.AUTH_RATE_LIMIT_MAX ??= '10000';
process.env.OTP_MAX_SENDS_PER_IDENTIFIER_PER_HOUR ??= '1000';
process.env.OTP_MAX_SENDS_PER_IP_PER_HOUR ??= '10000';
