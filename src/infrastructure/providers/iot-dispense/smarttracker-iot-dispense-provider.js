import { createLogger } from '../../../shared/logger/index.js';

import { IotDispenseError } from './iot-dispense-error.js';

const log = createLogger({ module: 'iot-dispense.smarttracker' });

/**
 * smarttracker / dezel4u dispense controller (vendor doc "dezel4u-001", rev 2).
 *
 *   GET {base}dispense/authorize.ashx
 *       ?deviceId=0001&vehicleRegistration=WB02AE4377
 *       &authorizedQuantityLitres=0025.00&mpin=2341&ID=260927113401
 *   → { "iotTransactionId": "...", "status": "AUTHORIZED",
 *       "lastAcceptedQty": "0000.00", "lastAcceptedTime": "000000000000",
 *       "deviceID": "0001", "vehicleRegNo": "WB02AE4377" }
 *
 * WE generate the MPIN (4 digits) and send it; the device accepts that MPIN.
 * The reply no longer carries one. deviceId is strictly 4 numeric characters.
 *
 * KNOWN GAPS in the vendor API, raised with them: plain HTTP, no credential,
 * a state-changing GET carrying the MPIN in the URL. Nothing here can fix
 * those; the adapter only makes sure a non-JSON or non-2xx answer is never
 * read as an authorization.
 *
 * @returns {import('./index.js').IotDispenseProvider}
 */

/** 25 → "0025.00"; 125.5 → "0125.50" (their example format). */
export const formatLitres = (litres) => {
  const [whole, frac] = Number(litres).toFixed(2).split('.');
  return `${whole.padStart(4, '0')}.${frac}`;
};

export const createSmarttrackerProvider = ({ baseUrl, timeoutMs = 15_000, http = fetch }) => {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

  return {
    name: 'smarttracker',

    authorize: async ({ deviceId, vehicleRegistration, litres, mpin, requestRef }) => {
      const url = new URL('dispense/authorize.ashx', base);
      url.searchParams.set('deviceId', deviceId);
      url.searchParams.set('vehicleRegistration', vehicleRegistration);
      url.searchParams.set('authorizedQuantityLitres', formatLitres(litres));
      url.searchParams.set('mpin', mpin);
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

      // They echo the device and vehicle. A mismatch would mean the unlock went
      // to a different pump than the one this order is on — log it loudly.
      if (
        (body.deviceID && String(body.deviceID) !== deviceId) ||
        (body.vehicleRegNo && String(body.vehicleRegNo) !== vehicleRegistration)
      ) {
        log.error(
          {
            sent: { deviceId, vehicleRegistration },
            got: { deviceID: body.deviceID, vehicleRegNo: body.vehicleRegNo },
          },
          'IoT authorize reply is for a different device/vehicle'
        );
      }

      return {
        status: String(body.status ?? 'UNKNOWN').toUpperCase(),
        iotTransactionId: body.iotTransactionId ? String(body.iotTransactionId) : null,
        raw: body,
      };
    },
  };
};
