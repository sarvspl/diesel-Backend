import { createLogger } from '../../../shared/logger/index.js';

import { FLOW_METER_STATUS, MEASUREMENT_MODEL } from './flow-meter-provider.js';

const log = createLogger({ module: 'flow-meter.mock' });

/**
 * Development flow-meter provider — STOCK model, matching dezel4u.
 *
 * Returns a plausible tank stock that FALLS a little on each read, so the
 * delivery flow — read at start, pump, read at stop, delivered = start − stop —
 * can be exercised locally with no device and no vendor account, the way the
 * console OTP provider exercises sign-in.
 *
 * Each vehicle starts from a stable stock derived from its registration, so a
 * run is reproducible; refills reset it once it runs low.
 *
 * @type {import('./flow-meter-provider.js').FlowMeterProvider}
 */

const FULL = 12_000; // a full bowser
const seen = new Map();

const startStockFor = (key) => {
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) % 4000;
  return 4000 + hash; // 4000–8000 L on hand
};

export const mockFlowMeterProvider = {
  name: 'mock',
  measurement: MEASUREMENT_MODEL.STOCK,

  async read({ fleetNumber, registration }) {
    const key = registration || fleetNumber || 'UNKNOWN';
    const current = seen.get(key) ?? startStockFor(key);

    const drop = 5 + (startStockFor(key) % 11); // 5–15 L dispensed between reads
    let next = current - drop;
    if (next < 100) next = FULL; // "refilled"
    seen.set(key, next);

    log.debug({ key, stock: next }, 'mock bowser read');

    return {
      measurement: MEASUREMENT_MODEL.STOCK,
      stockLitres: next.toFixed(3),
      totalizerGross: null,
      totalizerNet: null,
      temperatureC: null,
      registerMax: null,
      status: FLOW_METER_STATUS.IDLE,
      location: { latitude: 22.5726, longitude: 88.3639 },
      movementStatus: 'PARKED',
      capturedAt: new Date(),
      deviceRef: key,
      raw: { mock: true, key, stock: next },
    };
  },
};
