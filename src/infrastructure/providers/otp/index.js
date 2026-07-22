import { env } from '../../../config/env.js';

import { consoleOtpProvider } from './console-otp-provider.js';

/**
 * OTP provider selection.
 *
 * The single place that knows which implementation is active. Callers depend
 * on the interface in otp-provider.js and never import a concrete provider,
 * so adding a real SMS vendor is one entry in this map plus one value in the
 * OTP_PROVIDER env enum.
 */
const providers = {
  console: consoleOtpProvider,
};

/** @returns {import('./otp-provider.js').OtpProvider} */
export const getOtpProvider = () => {
  const provider = providers[env.OTP_PROVIDER];

  if (!provider) {
    // Unreachable while the env schema constrains OTP_PROVIDER to known values;
    // kept so that widening the enum without adding an implementation fails at
    // startup rather than on a user's first login attempt.
    throw new Error(`Unknown OTP provider: ${env.OTP_PROVIDER}`);
  }

  return provider;
};

export { generateNumericCode } from './otp-provider.js';
