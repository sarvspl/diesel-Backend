import { env } from '../../../config/env.js';

export { IotDispenseError } from './iot-dispense-error.js';
import { mockIotDispenseProvider } from './mock-iot-dispense-provider.js';
import { createSmarttrackerProvider } from './smarttracker-iot-dispense-provider.js';

/**
 * IoT dispense-authorization provider selection.
 *
 * Mirrors the flow-meter factory: callers depend on the shape below and never
 * import a vendor adapter directly.
 *
 * @typedef {Object} IotAuthorizeResult
 * @property {string}      status            Vendor status, "AUTHORIZED" on success.
 * @property {string|null} iotTransactionId
 * @property {string|null} mpin
 * @property {object}      raw               Vendor body, verbatim.
 *
 * @typedef {Object} IotDispenseProvider
 * @property {string} name
 * @property {(input: { deviceId: string, vehicleRegistration: string,
 *   litres: number, requestRef: string }) => Promise<IotAuthorizeResult>} authorize
 *   Throws {@link IotDispenseError} when the vendor cannot be reached or answers
 *   with something that is not a usable body.
 */

let smarttracker = null;

/** @returns {IotDispenseProvider | null} null when IOT_DISPENSE_PROVIDER=none. */
export const getIotDispenseProvider = () => {
  switch (env.IOT_DISPENSE_PROVIDER) {
    case 'none':
      return null;
    case 'mock':
      return mockIotDispenseProvider;
    case 'smarttracker':
      smarttracker ??= createSmarttrackerProvider({
        baseUrl: env.IOT_DISPENSE_BASE_URL,
        timeoutMs: env.IOT_DISPENSE_TIMEOUT_MS,
      });
      return smarttracker;
    default:
      throw new Error(`Unknown IoT dispense provider: ${env.IOT_DISPENSE_PROVIDER}`);
  }
};

/**
 * The vendor's `ID` cache-buster: yyMMddHHmmss in IST, as in their examples.
 * Second resolution, so it is NOT unique enough to be an idempotency key — our
 * own duplicate protection is the stored authorization row.
 */
export const requestRefFor = (date = new Date()) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );

  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`;
};
