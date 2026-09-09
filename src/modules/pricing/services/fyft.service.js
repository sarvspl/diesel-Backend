import {
  FlowMeterError,
  getFlowMeterProvider,
} from '../../../infrastructure/providers/flow-meter/index.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { ServiceUnavailableError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';

const log = createLogger({ module: 'pricing.fyft' });

/**
 * Push our HSD rate to the FYFT device platform.
 *
 * A one-way, display-only feed to the vendor — it does NOT touch our own
 * pricing, which stays per-location in `fuel_prices`. The operator types the
 * single figure FYFT should show and pushes it on demand. Only works when the
 * server runs a real flow-meter provider (`dezel4u`); on `manual` there is no
 * device to talk to, so it is a clean 503.
 */
export const pushHsdRate = async ({ rate }) => {
  const provider = getFlowMeterProvider();

  if (!provider || typeof provider.pushRate !== 'function') {
    throw new ServiceUnavailableError(
      'The FYFT integration is not configured on the server, so the rate cannot be sent.',
      { code: ERROR_CODES.METER_DEVICE_UNAVAILABLE }
    );
  }

  try {
    const result = await provider.pushRate({ rate });
    log.info({ rate, provider: provider.name }, 'HSD rate pushed to FYFT');
    return { rate: String(rate), provider: provider.name, sentAt: new Date().toISOString(), ...result };
  } catch (error) {
    if (error instanceof FlowMeterError) {
      throw new ServiceUnavailableError(`FYFT rejected the rate update (${error.code})`, {
        code: ERROR_CODES.METER_DEVICE_UNAVAILABLE,
      });
    }
    throw error;
  }
};
