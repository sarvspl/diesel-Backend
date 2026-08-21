/**
 * Environment configuration.
 *
 * This is the only module permitted to read `process.env`. Everything else
 * imports the frozen `env` object exported here, so the shape of configuration
 * is validated exactly once, at startup, and is impossible to typo at runtime.
 *
 * On invalid or missing configuration the process exits immediately with a
 * human-readable report rather than failing later with a confusing runtime
 * error. `console.error` is used deliberately: the logger itself depends on
 * this module, so it does not exist yet at this point.
 */
import 'dotenv/config';
import { z } from 'zod';

import { durationToSeconds } from '../shared/utils/duration.js';

/** Values that must never survive into a production deployment. */
const PLACEHOLDER_PATTERN = /^(change_?me|replace_?me|your_|xxx|todo|secret|password)/i;

/**
 * NOTE ON `.default()`: in Zod 4 a default short-circuits parsing, so the value
 * given to `.default()` must already be in the schema's OUTPUT type. For the
 * transforming schemas below that means passing the transformed value (an
 * array, a boolean) rather than the raw string a human would write in .env.
 * Passing the raw string silently skips the transform.
 */

/**
 * Comma-separated list -> trimmed, de-duplicated array of non-empty strings.
 * `CORS_ORIGIN="https://a.com, https://b.com"` -> ['https://a.com', 'https://b.com']
 */
const commaSeparatedList = z
  .string()
  .transform((value) => [...new Set(value.split(',').map((item) => item.trim()))].filter(Boolean));

/**
 * Express `trust proxy` accepts several shapes and they mean different things:
 *   'false'      -> trust nothing (correct when the app is directly exposed)
 *   'true'       -> trust every hop (only safe behind a proxy you control)
 *   '1' / '2'    -> trust N hops closest to the app
 *   'loopback'   -> named preset, or a CIDR / comma-separated list
 * Getting this wrong silently breaks rate limiting and request IP logging,
 * so it is configuration rather than a hard-coded value.
 */
const trustProxy = z.string().transform((value) => {
  const normalised = value.trim().toLowerCase();
  if (normalised === 'false' || normalised === '') return false;
  if (normalised === 'true') return true;
  if (/^\d+$/.test(normalised)) return Number.parseInt(normalised, 10);
  return value.trim();
});

/**
 * Secrets are only meaningfully validated for length and obvious placeholders.
 * 32 bytes is the floor for HS256 to actually carry 256 bits of entropy.
 */
const secret = (name) =>
  z
    .string()
    .min(32, `${name} must be at least 32 characters (use: openssl rand -base64 48)`)
    .refine(
      (value) => !PLACEHOLDER_PATTERN.test(value),
      `${name} still looks like the placeholder from .env.example - generate a real secret`
    );

/** Accepts the `15m` / `7d` / `3600` forms understood by JWT libraries. */
const duration = z
  .string()
  .regex(/^\d+[smhdwy]?$/, 'must be a number optionally followed by s, m, h, d, w or y');

const envSchema = z
  .object({
    // --- Runtime ---------------------------------------------------------
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().min(1).default('0.0.0.0'),
    APP_NAME: z.string().min(1).default('diesel-for-you-backend'),

    // --- Database --------------------------------------------------------
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required')
      .refine(
        (value) => /^postgres(ql)?:\/\//.test(value),
        'DATABASE_URL must be a PostgreSQL connection string (postgresql://...)'
      ),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),

    // --- Authentication --------------------------------------------------
    // Consumed by the identity module in the next phase. Validated now so that
    // a deployment cannot start without them and then fail on first login.
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
    JWT_ACCESS_EXPIRES_IN: duration.default('15m'),
    JWT_REFRESH_EXPIRES_IN: duration.default('30d'),

    /**
     * Hard ceiling on a session, fixed at login and never extended by rotation.
     *
     * JWT_REFRESH_EXPIRES_IN is a SLIDING window - each rotation pushes it out,
     * which is what keeps an active user signed in. On its own that means a
     * session never dies, including one an attacker keeps alive with a stolen
     * token. This is the backstop that forces periodic re-authentication.
     */
    SESSION_ABSOLUTE_LIFETIME: duration.default('90d'),

    // --- HTTP ------------------------------------------------------------
    CORS_ORIGIN: commaSeparatedList.default(['http://localhost:3000']),
    BODY_LIMIT: z.string().min(1).default('100kb'),
    TRUST_PROXY: trustProxy.default(false),

    // --- Password hashing --------------------------------------------------
    // OWASP-recommended Argon2id baseline: 19 MiB, 2 iterations, 1 lane.
    // Tunable because the right cost depends on the host - raise memory until
    // a hash takes roughly 100ms on production hardware.
    ARGON2_MEMORY_COST_KIB: z.coerce.number().int().min(8_192).default(19_456),
    ARGON2_TIME_COST: z.coerce.number().int().min(2).default(2),
    ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

    // --- Rate limiting ---------------------------------------------------
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(900_000), // 15 minutes
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(300),

    // Authentication endpoints get their own, far stricter budget: the global
    // limit is sized for ordinary API traffic and would allow thousands of
    // credential-stuffing attempts inside one window.
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(900_000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),

    // --- OTP ---------------------------------------------------------------
    // Provider abstraction only in this phase. `console` prints the code to the
    // log in development; an SMS provider is added later without touching
    // callers (ADR-011). See src/infrastructure/providers/otp/.
    OTP_PROVIDER: z.enum(['console']).default('console'),
    OTP_LENGTH: z.coerce.number().int().min(4).max(10).default(6),
    OTP_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),

    /**
     * A FIXED OTP for every account, e.g. `123456`.
     *
     * THIS IS AN AUTHENTICATION BYPASS. While it is set, anyone who knows a
     * phone number can sign in as that person — driver, customer or admin —
     * because the code is no longer a secret. It exists so a staging box with
     * no SMS vendor can still be demonstrated end to end.
     *
     * It works in EVERY environment, production included, because the staging
     * deployment runs `NODE_ENV=production` and the alternative — running a
     * public host in development mode — would also relax CORS and leak stack
     * traces in error responses. This is the narrower hole of the two.
     *
     * The name is the guard rail. Nothing called INSECURE gets into a real
     * deployment's config by accident, and it is impossible to miss in a
     * review. It is also announced loudly at every boot and on every code
     * issued. Unset it and CSPRNG codes return with no other change.
     */
    OTP_INSECURE_FIXED_CODE: z
      .string()
      .regex(/^\d{4,10}$/, 'OTP_INSECURE_FIXED_CODE must be 4-10 digits')
      .optional(),

    /**
     * OTP anti-abuse limits (BR-113, BR-114).
     *
     * Configuration rather than constants: these are exactly the numbers an
     * operator needs to tighten at 2 a.m. during an SMS-pumping incident, and
     * requiring a deployment to do it is the wrong trade (docs/11 §8.1).
     *
     * The per-IP limit is the commercially important one - it is what stops an
     * attacker rotating phone numbers to run up the operator's SMS bill.
     */
    /**
     * How long a verified fuel reading stays trustworthy, in hours.
     *
     * Past this, `dispatchability` raises FUEL_STATE_STALE and the tanker
     * cannot be sent: dispatch reserves against a number, and a number nobody
     * has checked since yesterday is a guess.
     *
     * Configuration because it is an operational trade-off — a shorter window
     * means more dip readings and fewer surprises at the customer's tank.
     */
    INVENTORY_STALE_AFTER_HOURS: z.coerce.number().int().min(1).max(720).default(12),

    OTP_MAX_SENDS_PER_IDENTIFIER_PER_HOUR: z.coerce.number().int().min(1).default(3),
    OTP_MAX_SENDS_PER_IP_PER_HOUR: z.coerce.number().int().min(1).default(20),
    OTP_MAX_VERIFY_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),

    // --- Flow meter / bowser (IoT) -----------------------------------------
    // `manual` (default) = no device; drivers type the reading as today.
    // `mock` = synthetic stock for local dev. `dezel4u` = the FYFT
    // bowser-monitoring platform (current tank stock). See
    // src/infrastructure/providers/flow-meter/ and docs/16.
    FLOW_METER_PROVIDER: z.enum(['manual', 'mock', 'dezel4u']).default('manual'),
    // The driver is standing at the tanker; a slow API must fail over to manual
    // rather than hang the delivery.
    FLOW_METER_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(4000),

    // dezel4u / FYFT. The source code is a secret, bound to this server's IP by
    // the vendor. Required only when FLOW_METER_PROVIDER=dezel4u.
    FYFT_SOURCE_CODE: z.string().optional(),
    FYFT_BASE_URL: z.string().url().default('https://www.dezel4u.com/go_fyft'),

    // --- Observability ---------------------------------------------------
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // --- Pricing -----------------------------------------------------------
    /**
     * How long a quote holds its price (BR-604, 15 minutes proposed).
     *
     * Configuration because it is a commercial trade-off, not a constant:
     * too short and customers are re-quoted mid-checkout, too long and the
     * platform is exposed when the daily rate revises around 06:00 IST.
     */
    QUOTE_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),

    // --- Ordering ----------------------------------------------------------
    /**
     * How long an unpaid order holds its fuel before expiring (BR-1006).
     *
     * The trade-off: too short and a customer loses their order while finding
     * their card; too long and a tanker's stock is sterilised by orders nobody
     * intends to pay for.
     */
    ORDER_PAYMENT_WINDOW_MINUTES: z.coerce.number().int().min(5).max(1_440).default(30),

    /**
     * How long a fuel reservation survives without the order progressing
     * (BR-407). Longer than the payment window on purpose: the reservation must
     * outlive the order state that justifies it, or a confirmed order loses its
     * fuel while waiting for a vehicle.
     */
    RESERVATION_TTL_MINUTES: z.coerce.number().int().min(10).max(2_880).default(120),

    /**
     * The window in which an identical order (same address, same quantity) is
     * treated as a probable double-submission and warned about (BR-804).
     *
     * A SOFT warning, distinct from the Idempotency-Key which is a hard
     * guarantee. This catches the customer who genuinely tapped twice across
     * two separate requests with two different keys.
     */
    DUPLICATE_ORDER_WINDOW_MINUTES: z.coerce.number().int().min(0).max(120).default(5),

    // --- Platform ----------------------------------------------------------
    /**
     * How long an idempotency record is retained (ADR-013 requires a retention
     * policy but states no figure; 24 hours matches the archived design).
     *
     * It bounds how long a retry is safe. Beyond it the key is forgotten and a
     * replay would create a second order - so it must comfortably exceed any
     * realistic client retry schedule.
     */
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),

    // --- Lifecycle -------------------------------------------------------
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message:
          'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET, otherwise an access token can be replayed as a refresh token',
      });
    }

    if (
      durationToSeconds(value.SESSION_ABSOLUTE_LIFETIME) <
      durationToSeconds(value.JWT_REFRESH_EXPIRES_IN)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_ABSOLUTE_LIFETIME'],
        message:
          'SESSION_ABSOLUTE_LIFETIME must be at least JWT_REFRESH_EXPIRES_IN, otherwise every session is dead before its first refresh token expires',
      });
    }

    if (value.NODE_ENV === 'production' && value.CORS_ORIGIN.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGIN'],
        message: 'CORS_ORIGIN cannot be "*" in production - list the allowed origins explicitly',
      });
    }

  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const report = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  console.error(
    [
      '',
      'Invalid environment configuration. The server will not start.',
      '',
      report,
      '',
      'Copy .env.example to .env and fill in the missing values.',
      '',
    ].join('\n')
  );

  process.exit(1);
}

/** Validated, immutable application configuration. */
export const env = Object.freeze(parsed.data);

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
