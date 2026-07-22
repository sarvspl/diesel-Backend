/**
 * Duration parsing.
 *
 * Deliberately dependency-free. `config/env.js` needs it to validate that
 * SESSION_ABSOLUTE_LIFETIME exceeds JWT_REFRESH_EXPIRES_IN, and the token
 * service needs it to compute expiry dates. Keeping it here means env.js does
 * not import a service that imports env.js back - the circular dependency the
 * lint rule exists to catch.
 */

const SECONDS_PER_UNIT = Object.freeze({
  s: 1,
  m: 60,
  h: 3_600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
});

/**
 * Convert the `15m` / `30d` / `3600` forms accepted by the duration env vars
 * into seconds. A bare number is treated as seconds, matching JWT libraries.
 *
 * @param {string} duration
 * @returns {number}
 */
export const durationToSeconds = (duration) => {
  const unit = duration.at(-1);
  const multiplier = SECONDS_PER_UNIT[unit];

  return multiplier === undefined
    ? Number.parseInt(duration, 10)
    : Number.parseInt(duration.slice(0, -1), 10) * multiplier;
};

/**
 * @param {string} duration
 * @param {Date} [from]
 * @returns {Date}
 */
export const durationFromNow = (duration, from = new Date()) =>
  new Date(from.getTime() + durationToSeconds(duration) * 1_000);
