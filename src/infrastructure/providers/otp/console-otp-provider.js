import { isProduction } from '../../../config/env.js';
import { createLogger } from '../../../shared/logger/index.js';

const log = createLogger({ module: 'otp.console' });

/**
 * Development OTP provider.
 *
 * Writes the code to the log instead of sending an SMS, so the whole
 * authentication flow can be exercised locally with no vendor account, no DLT
 * registration and no cost (ADR-011).
 *
 * @type {import('./otp-provider.js').OtpProvider}
 */
export const consoleOtpProvider = {
  name: 'console',

  async send({ identifier, code, purpose, ttlSeconds }) {
    // Hard refusal rather than a warning. An operator who misconfigures
    // OTP_PROVIDER in production would otherwise get a service that appears
    // healthy while printing every login code into the log aggregator, where
    // it is retained and searchable. Failing loudly is the safe direction.
    if (isProduction) {
      throw new Error(
        'consoleOtpProvider must never run in production - configure a real SMS provider'
      );
    }

    log.info(
      {
        identifier,
        purpose,
        ttlSeconds,
        // The code appears here ONLY because this provider is unreachable in
        // production. No other code path may log an OTP (BR-111).
        devOnlyCode: code,
      },
      'OTP generated (development only - not sent)'
    );

    return { delivered: true, provider: this.name };
  },
};
