import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IotDispenseError,
  requestRefFor,
} from '../../src/infrastructure/providers/iot-dispense/index.js';
import { createSmarttrackerProvider } from '../../src/infrastructure/providers/iot-dispense/smarttracker-iot-dispense-provider.js';

/**
 * The smarttracker adapter unlocks a real pump, so the one property that
 * matters most is negative: nothing but a 2xx JSON body is ever read as an
 * authorization.
 */

const fakeHttp =
  (status, text, seen = {}) =>
  async (url) => {
    seen.url = url;
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };

const input = {
  deviceId: '00001',
  vehicleRegistration: 'WB02AE4377',
  litres: 25,
  requestRef: '260927113401',
};

describe('smarttracker IoT dispense adapter', () => {
  it('builds the vendor URL with a zero-padded quantity and the cache-buster', async () => {
    const seen = {};
    const provider = createSmarttrackerProvider({
      baseUrl: 'http://www.smarttracker.live/dezel4u/v1/',
      http: fakeHttp(
        200,
        '{"iotTransactionId":"00001260928225749","mpin":"123456","status":"AUTHORIZED"}',
        seen
      ),
    });

    const result = await provider.authorize(input);

    assert.equal(
      String(seen.url),
      'http://www.smarttracker.live/dezel4u/v1/dispense/authorize.ashx?deviceId=00001&vehicleRegistration=WB02AE4377&authorizedQuantityLitres=0025&ID=260927113401'
    );
    assert.equal(result.status, 'AUTHORIZED');
    assert.equal(result.mpin, '123456');
    assert.equal(result.iotTransactionId, '00001260928225749');
  });

  it('passes a non-AUTHORIZED status through for the service to refuse', async () => {
    const provider = createSmarttrackerProvider({
      baseUrl: 'http://x.test/v1',
      http: fakeHttp(200, '{"status":"denied"}'),
    });

    const result = await provider.authorize(input);
    assert.equal(result.status, 'DENIED');
    assert.equal(result.mpin, null);
  });

  it('throws on a non-JSON reply (e.g. an HTML error page)', async () => {
    const provider = createSmarttrackerProvider({
      baseUrl: 'http://x.test/v1/',
      http: fakeHttp(200, '<html>Runtime Error</html>'),
    });

    await assert.rejects(provider.authorize(input), IotDispenseError);
  });

  it('throws on an HTTP error even with a JSON body', async () => {
    const provider = createSmarttrackerProvider({
      baseUrl: 'http://x.test/v1/',
      http: fakeHttp(500, '{"status":"AUTHORIZED","mpin":"1"}'),
    });

    await assert.rejects(provider.authorize(input), IotDispenseError);
  });

  it('throws when the network fails', async () => {
    const provider = createSmarttrackerProvider({
      baseUrl: 'http://x.test/v1/',
      http: async () => {
        throw new TypeError('fetch failed');
      },
    });

    await assert.rejects(provider.authorize(input), IotDispenseError);
  });
});

describe('requestRefFor', () => {
  it('formats yyMMddHHmmss in IST', () => {
    // 2026-09-27 05:34:01Z = 11:04:01 IST
    assert.equal(requestRefFor(new Date('2026-09-27T05:34:01Z')), '260927110401');
  });
});
