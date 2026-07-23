import { env, isProduction } from '../../../config/env.js';
import {
  generateNumericCode,
  getOtpProvider,
} from '../../../infrastructure/providers/otp/index.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { TooManyRequestsError, UnauthorizedError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as otpRepository from '../repositories/otp.repository.js';

import { hashPassword, verifyPassword } from './password.service.js';

const log = createLogger({ module: 'identity.otp' });

/**
 * One-time password issue and verification.
 *
 * The provider only delivers; every security property lives here.
 *
 * Limits, and why each exists (BR-110 - BR-116):
 *   expiry            a code is guessable given unlimited time
 *   attempt cap       6 digits is 1e6 guesses; unlimited tries defeats that
 *   single use        a replayed code is a second authentication
 *   resend cooldown   stops a caller cycling codes to reset the attempt budget
 *   per-identifier    caps cost and nuisance to one victim
 *   per-IP            the one that matters commercially: without it an
 *                     attacker rotates numbers and bills the operator for SMS
 */

/** Resend cooldown, growing with each resend in the current sequence. */
const RESEND_COOLDOWN_SECONDS = [30, 60, 120, 300];

/**
 * Configuration, not constants (docs/11 §8.1). These are the numbers an
 * operator tightens during an SMS-pumping incident, and needing a deployment
 * to change them would be the wrong trade.
 */
const MAX_SENDS_PER_IDENTIFIER_PER_HOUR = env.OTP_MAX_SENDS_PER_IDENTIFIER_PER_HOUR;
const MAX_SENDS_PER_IP_PER_HOUR = env.OTP_MAX_SENDS_PER_IP_PER_HOUR;
const MAX_VERIFY_ATTEMPTS = env.OTP_MAX_VERIFY_ATTEMPTS;

const oneHourAgo = () => new Date(Date.now() - 3_600_000);

const cooldownFor = (resendCount) =>
  RESEND_COOLDOWN_SECONDS[Math.min(resendCount, RESEND_COOLDOWN_SECONDS.length - 1)];

/**
 * The code to issue.
 *
 * Normally a CSPRNG value. When `OTP_INSECURE_FIXED_CODE` is set it is that
 * constant instead, in EVERY environment — see the note on the variable in
 * `env.js` for why production is included and what it costs.
 *
 * Logged at `warn` on every issue rather than only at boot: a bypass that is
 * announced once, days ago, in a log nobody is tailing, is a bypass nobody
 * remembers is on.
 */
const issueCode = () => {
  if (env.OTP_INSECURE_FIXED_CODE) {
    log.warn(
      { insecureFixedOtp: true },
      'OTP AUTHENTICATION BYPASS: issuing the configured fixed code, not a random one'
    );
    return env.OTP_INSECURE_FIXED_CODE;
  }

  return generateNumericCode(env.OTP_LENGTH);
};

/**
 * Issue a code, or resend the current one's replacement.
 *
 * Returns `expiresAt` and `retryAfterSeconds` but NEVER the code, except in
 * development where the console provider is active and the caller has no SMS.
 *
 * @returns {Promise<{ challengeId: string, expiresAt: Date, retryAfterSeconds: number, devCode?: string }>}
 */
export const requestOtp = async ({ identifier, principal, purpose, ipAddress }) => {
  const existing = await otpRepository.findLive({ identifier, principal, purpose });

  if (existing) {
    const elapsedSeconds = (Date.now() - existing.createdAt.getTime()) / 1_000;
    const cooldown = cooldownFor(existing.resendCount);

    if (elapsedSeconds < cooldown) {
      throw new TooManyRequestsError(
        'A code was just sent. Please wait before requesting another.',
        {
          code: ERROR_CODES.OTP_RESEND_TOO_SOON,
          details: { retryAfterSeconds: Math.ceil(cooldown - elapsedSeconds) },
        }
      );
    }
  }

  const sentToIdentifier = await otpRepository.countSince({
    identifier,
    principal,
    since: oneHourAgo(),
  });

  if (sentToIdentifier >= MAX_SENDS_PER_IDENTIFIER_PER_HOUR) {
    log.warn({ identifier, principal, sentToIdentifier }, 'OTP send limit reached for identifier');
    throw new TooManyRequestsError('Too many codes requested. Please try again later.', {
      code: ERROR_CODES.OTP_RATE_LIMITED,
    });
  }

  if (ipAddress) {
    const sentFromIp = await otpRepository.countByIpSince({ ipAddress, since: oneHourAgo() });

    if (sentFromIp >= MAX_SENDS_PER_IP_PER_HOUR) {
      // Logged at warn with the IP: this is the signature of SMS-pumping fraud
      // and someone should see it.
      log.warn({ ipAddress, sentFromIp }, 'OTP send limit reached for IP');
      throw new TooManyRequestsError('Too many codes requested. Please try again later.', {
        code: ERROR_CODES.OTP_RATE_LIMITED,
      });
    }
  }

  // Exactly one code may be live at a time. A resend invalidates its
  // predecessor, otherwise each resend would hand the attacker another
  // simultaneously valid guess target with its own fresh attempt budget.
  await otpRepository.consumeAllLive({ identifier, principal, purpose });

  const code = issueCode();

  const challenge = await otpRepository.create({
    identifier,
    principal,
    purpose,
    // Hashed exactly like a password. A database leak must not yield live codes.
    codeHash: await hashPassword(code),
    expiresAt: new Date(Date.now() + env.OTP_TTL_SECONDS * 1_000),
    maxAttempts: MAX_VERIFY_ATTEMPTS,
    resendCount: existing ? existing.resendCount + 1 : 0,
    ipAddress,
  });

  await getOtpProvider().send({
    identifier,
    code,
    purpose,
    ttlSeconds: env.OTP_TTL_SECONDS,
  });

  return {
    challengeId: challenge.id,
    expiresAt: challenge.expiresAt,
    retryAfterSeconds: cooldownFor(challenge.resendCount),
    /**
     * The code, echoed back to the caller.
     *
     * Outside production this is ordinary development convenience. In
     * production it is returned ONLY when the code is the configured fixed
     * constant — which is not a secret by construction, so echoing it
     * discloses nothing that setting the variable has not already disclosed.
     *
     * A genuinely random production code is never echoed, which is the case
     * this condition exists to protect.
     */
    ...(isProduction && !env.OTP_INSECURE_FIXED_CODE ? {} : { devCode: code }),
  };
};

/**
 * Verify a submitted code.
 *
 * Consumes the challenge on success. Every failure mode returns the SAME error
 * so a caller cannot learn whether a challenge exists, has expired, or simply
 * had the wrong code - each of those would confirm that the identifier is
 * registered.
 *
 * @returns {Promise<{ verified: true }>}
 */
export const verifyOtp = async ({ identifier, principal, purpose, code }) => {
  const invalid = () =>
    new UnauthorizedError('The code is invalid or has expired', {
      code: ERROR_CODES.OTP_INVALID,
    });

  const challenge = await otpRepository.findLive({ identifier, principal, purpose });

  if (!challenge) {
    // Burn comparable time so "no challenge" is not measurably faster than a
    // real Argon2 verification.
    await verifyPassword(null, code);
    throw invalid();
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    await otpRepository.consume(challenge.id);
    throw new UnauthorizedError('Too many incorrect attempts. Request a new code.', {
      code: ERROR_CODES.OTP_ATTEMPTS_EXCEEDED,
    });
  }

  const matches = await verifyPassword(challenge.codeHash, code);

  if (!matches) {
    const { attempts, exhausted } = await otpRepository.registerFailedAttempt(challenge.id);

    if (exhausted) {
      await otpRepository.consume(challenge.id);
      log.warn({ identifier, principal, purpose, attempts }, 'OTP attempts exhausted');
    }

    throw invalid();
  }

  // Single use, enforced by a conditional update. Two concurrent verifications
  // of the same correct code must not both succeed.
  const consumed = await otpRepository.consume(challenge.id);

  if (consumed === 0) {
    throw invalid();
  }

  return { verified: true };
};

/** Remove spent and expired challenges. Intended for a scheduled job. */
export const purgeSpentChallenges = async ({ retainDays = 7 } = {}) => {
  const before = new Date(Date.now() - retainDays * 86_400 * 1_000);
  const deleted = await otpRepository.deleteSpent(before);

  log.info({ deleted, retainDays }, 'spent OTP challenges purged');

  return { deleted };
};
