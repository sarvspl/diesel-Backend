import pino from 'pino';

import { env, isDevelopment } from '../../config/env.js';

/**
 * Fields scrubbed from every log record before it is written.
 *
 * This list is the enforcement point for "never log credentials". It is
 * deliberately broader than what the current code paths produce, so that a
 * future module logging a whole request body cannot leak a secret by accident.
 *
 * Each entry is matched literally; `*.foo` matches `foo` one level deep inside
 * any object. Add both forms when a field can appear at either depth.
 */
const REDACTED_PATHS = [
  // Request/response headers
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-refresh-token"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',

  // Credentials and tokens
  'password',
  '*.password',
  'currentPassword',
  '*.currentPassword',
  'newPassword',
  '*.newPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'refreshTokenHash',
  '*.refreshTokenHash',
  'secret',
  '*.secret',
  'apiKey',
  '*.apiKey',
  'authorization',
  '*.authorization',

  // One-time passwords
  'otp',
  '*.otp',
  'otpCode',
  '*.otpCode',
  'otpHash',
  '*.otpHash',

  // Payment instruments
  'cardNumber',
  '*.cardNumber',
  'cvv',
  '*.cvv',
  'pin',
  '*.pin',
  'upiId',
  '*.upiId',
  'accountNumber',
  '*.accountNumber',

  // Connection strings carry the database password
  'DATABASE_URL',
  '*.DATABASE_URL',
  'connectionString',
  '*.connectionString',
];

/**
 * Development gets human-readable colourised output; every other environment
 * gets newline-delimited JSON for log shipping.
 */
const transport = isDevelopment
  ? {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
      },
    }
  : undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  transport,
  redact: {
    paths: REDACTED_PATHS,
    censor: '[REDACTED]',
  },
  // Emit the level as a label ("info") rather than a number, so log queries
  // read naturally in whatever aggregator this lands in.
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  base: {
    service: env.APP_NAME,
    env: env.NODE_ENV,
  },
});

/**
 * Child logger with fixed bindings, e.g.
 *   const log = createLogger({ module: 'dispatch' });
 *
 * @param {Record<string, unknown>} bindings
 */
export const createLogger = (bindings) => logger.child(bindings);
