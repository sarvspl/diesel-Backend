/**
 * Verify the dezel4u/FYFT flow-meter adapter against the vendor's OWN sample
 * payloads, with a fake HTTP client — the live endpoint is bound to the
 * production server's IP and cannot be reached from a dev box, so this proves
 * the mapping and auth handling without it.
 *
 *   node scripts/verify-flow-meter.mjs
 */
import { createDezel4uProvider } from '../src/infrastructure/providers/flow-meter/dezel4u-flow-meter-provider.js';
import {
  deliveredFromStock,
  MEASUREMENT_MODEL,
} from '../src/infrastructure/providers/flow-meter/flow-meter-provider.js';

let passed = 0;
let failed = 0;

const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  [32mPASS[0m ${label}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m ${label}\n       ${detail}`);
  }
};
const equal = (label, actual, expected) =>
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** A JWT whose payload decodes to the given exp (seconds). */
const makeToken = (expSeconds) => {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ exp: expSeconds })}.sig`;
};

/** A fake `fetch` that replies from a per-URL script, and counts calls. */
const fakeHttp = (routes) => {
  const calls = { fetch_jwt: 0, check_bowstock: 0 };
  return {
    calls,
    http: async (url, opts) => {
      const key = url.includes('fetch_jwt') ? 'fetch_jwt' : 'check_bowstock';
      calls[key] += 1;
      const body = routes[key](calls[key], opts);
      return { ok: true, status: 200, json: async () => body };
    },
  };
};

async function main() {
  const FUTURE = Math.floor(Date.now() / 1000) + 3600;

  // The vendor's own examples, verbatim.
  const SAMPLE_JWT = { result: true, token: makeToken(FUTURE) };
  const SAMPLE_STOCK = {
    result: true,
    stock: '592.86L',
    latitude: 22.5339416,
    longitude: 88.2994033,
    movement_status: 'PARKED',
  };

  console.log('\n[1m1. MAPS THE SAMPLE check_bowstock RESPONSE[0m');

  let f = fakeHttp({
    fetch_jwt: () => SAMPLE_JWT,
    check_bowstock: () => SAMPLE_STOCK,
  });
  let provider = createDezel4uProvider({ sourceCode: 'TEST', http: f.http });

  const reading = await provider.read({ registration: 'WB19V0441' });
  equal('measurement is STOCK', reading.measurement, MEASUREMENT_MODEL.STOCK);
  equal('stock "592.86L" -> "592.860"', reading.stockLitres, '592.860');
  equal('no totaliser (stock device)', reading.totalizerGross, null);
  equal('no temperature', reading.temperatureC, null);
  equal('latitude parsed', reading.location?.latitude, 22.5339416);
  equal('longitude parsed', reading.location?.longitude, 88.2994033);
  equal('movement status carried', reading.movementStatus, 'PARKED');
  equal('device ref is the registration', reading.deviceRef, 'WB19V0441');
  check('raw payload kept for audit', reading.raw?.stock === '592.86L', JSON.stringify(reading.raw));

  console.log('\n[1m2. DELIVERED = STOCK BEFORE - AFTER[0m');
  const before = await (async () => reading.stockLitres)();
  // A second read after dispensing 400 L.
  f = fakeHttp({
    fetch_jwt: () => SAMPLE_JWT,
    check_bowstock: () => ({ ...SAMPLE_STOCK, stock: '192.86L' }),
  });
  provider = createDezel4uProvider({ sourceCode: 'TEST', http: f.http });
  const after = (await provider.read({ registration: 'WB19V0441' })).stockLitres;

  const delivered = deliveredFromStock(before, after);
  check('a normal delivery computes', delivered.ok, JSON.stringify(delivered));
  equal('  592.860 - 192.860 = 400.000 L', delivered.litres, '400.000');

  const refill = deliveredFromStock('100.000', '900.000');
  check('a stock INCREASE is refused, not billed as negative', !refill.ok, JSON.stringify(refill));
  equal('  reported as STOCK_INCREASED', refill.code, 'STOCK_INCREASED');

  console.log('\n[1m3. TOKEN IS CACHED (no re-auth on the second read)[0m');
  f = fakeHttp({ fetch_jwt: () => SAMPLE_JWT, check_bowstock: () => SAMPLE_STOCK });
  provider = createDezel4uProvider({ sourceCode: 'TEST', http: f.http });
  await provider.read({ registration: 'WB19V0441' });
  await provider.read({ registration: 'WB19V0441' });
  equal('fetch_jwt called once for two reads', f.calls.fetch_jwt, 1);
  equal('check_bowstock called twice', f.calls.check_bowstock, 2);

  console.log('\n[1m4. AUTH ERROR -> REFRESH TOKEN AND RETRY ONCE[0m');
  f = fakeHttp({
    fetch_jwt: () => SAMPLE_JWT,
    // First data call rejects with their auth error; second succeeds.
    check_bowstock: (n) =>
      n === 1
        ? { result: '3', msg: 'Authentication Error [source_code & IP not matching]' }
        : SAMPLE_STOCK,
  });
  provider = createDezel4uProvider({ sourceCode: 'TEST', http: f.http });
  const recovered = await provider.read({ registration: 'WB19V0441' });
  equal('recovers after a token refresh', recovered.stockLitres, '592.860');
  equal('re-authenticated exactly once', f.calls.fetch_jwt, 2);

  console.log('\n[1m5. A DOTLESS / UNDECODABLE TOKEN STILL WORKS (60h fallback)[0m');
  f = fakeHttp({
    fetch_jwt: () => ({ result: true, token: 'no-dots-here' }),
    check_bowstock: () => SAMPLE_STOCK,
  });
  provider = createDezel4uProvider({ sourceCode: 'TEST', http: f.http });
  const stillWorks = await provider.read({ registration: 'WB19V0441' });
  check('reads fine even if exp cannot be decoded', stillWorks.stockLitres === '592.860', 'failed');

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Harness error:', error);
  process.exitCode = 1;
});
