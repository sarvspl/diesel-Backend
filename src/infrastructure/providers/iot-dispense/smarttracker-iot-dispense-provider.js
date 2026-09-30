import { createLogger } from '../../../shared/logger/index.js';

import { IotDispenseError } from './iot-dispense-error.js';

const log = createLogger({ module: 'iot-dispense.smarttracker' });

/**
 * smarttracker / dezel4u dispense controller (vendor doc "dezel4u-001").
 *
 *   GET {base}dispense/authorize.ashx
 *       ?deviceId=00001&vehicleRegistration=WB02AE4377
 *       &authorizedQuantityLitres=0025&ID=260927113401
 *   → { "iotTransactionId": "...", "mpin": "123456", "status": "AUTHORIZED" }
 *
 * KNOWN GAPS in the vendor API, raised with them: plain HTTP, no credential,
 * a state-changing GET, no documented error shape. Nothing here can fix those;
 * the adapter only makes sure a non-JSON or non-2xx answer is never read as an
 * authorization.
 *
 * @returns {import('./index.js').IotDispenseProvider}
 */
export const createSmarttrackerProvider = ({ baseUrl, timeoutMs = 15_000, http = fetch }) => {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  return {
    name: 'smarttracker',

    authorize: async ({ deviceId, vehicleRegistration, litres, requestRef }) => {
      const url = new URL('dispense/authorize.ashx', base);
      url.searchParams.set('deviceId', deviceId);
      url.searchParams.set('vehicleRegistration', vehicleRegistration);
      // Their example is zero-padded to 4 digits ("0025").
      url.searchParams.set('authorizedQuantityLitres', String(litres).padStart(4, '0'));
      url.searchParams.set('ID', requestRef);

      let res;
      let text;

      try {
        res = await http(url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        log.warn({ err: err.message, deviceId }, 'IoT authorize request failed');
        throw new IotDispenseError('Could not reach the IoT pump service', {
          cause: err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK',
        });
      }

      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* handled below */
      }

      if (!res.ok || !body || typeof body !== 'object') {
        log.warn(
          { status: res.status, deviceId, body: text?.slice(0, 300) },
          'IoT authorize bad reply'
        );
        throw new IotDispenseError('The IoT pump service returned an unexpected reply', {
          httpStatus: res.status,
          body: text?.slice(0, 500) ?? null,
        });
      }

      return {
        status: String(body.status ?? 'UNKNOWN').toUpperCase(),
        iotTransactionId: body.iotTransactionId ? String(body.iotTransactionId) : null,
        mpin: body.mpin ? String(body.mpin) : null,
        raw: body,
      };
    },
  };
};
