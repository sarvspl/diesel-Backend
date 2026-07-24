/**
 * Prices and delivery charges resolve by PIN CODE first, then city, then the
 * unscoped default.
 *
 *   node scripts/verify-price-scoping.mjs
 *
 * Exists because the alternative — scoping on the city string — silently fails.
 * The `city` on an address is whatever the customer's phone geocoded, so the
 * same site arrives as "Chakpachuria", "New Town" or "Kolkata" depending on the
 * device. A rate published for the wrong one of those matches nothing, and the
 * only symptom is the customer being told we do not deliver to their address.
 */
import { prisma } from '../src/infrastructure/database/prisma.js';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1';
const CODE = process.env.OTP_INSECURE_FIXED_CODE ?? '123456';

let passed = 0;
let failed = 0;
const failures = [];

const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  [32mPASS[0m ${label}`);
  } else {
    failed += 1;
    failures.push(`${label}: ${detail}`);
    console.log(`  [31mFAIL[0m ${label}\n       ${detail}`);
  }
};

const equal = (label, actual, expected) =>
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const section = (title) => console.log(`\n[1m${title}[0m`);

async function call(method, path, { body, token } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, data: payload?.data, code: payload?.error?.code };
}

const stamp = String(Date.now()).slice(-5);
const CITY = `ScopeCity${stamp}`;
const PIN = `7${stamp}`;
const OTHER_PIN = '400001';

async function main() {
  console.log(`Verifying price and delivery scoping against ${BASE}\n`);

  const userRepository = await import('../src/modules/identity/repositories/user.repository.js');
  const { signAccessToken } = await import('../src/modules/identity/services/token.service.js');

  let adminToken = null;
  for (const candidate of await prisma.user.findMany({
    where: { principal: 'ADMIN' },
    select: { id: true },
  })) {
    const loaded = await userRepository.findByIdWithRoles(candidate.id);
    const flat = userRepository.flattenAuthorisation(loaded);
    if (flat.permissions.includes('price.manage')) {
      adminToken = signAccessToken({
        userId: loaded.id,
        principal: 'ADMIN',
        sessionId: 'verify-scoping',
        roles: flat.roles,
        permissions: flat.permissions,
      });
      break;
    }
  }

  if (!adminToken) {
    console.log('No ADMIN holds price.manage. Run `npm run seed:superadmin`.');
    process.exitCode = 1;
    return;
  }

  const product = await prisma.fuelProduct.findFirst({
    where: { code: 'HSD' },
    select: { id: true },
  });

  // --- Publish two rates and two rules of differing specificity -------------
  section('1. CONFIGURE');

  const publish = (body) =>
    call('POST', '/admin/prices', { token: adminToken, body: { productId: product.id, ...body } });

  const byCity = await publish({ city: CITY, pricePerUnit: '90.00' });
  equal('a price scoped to a city', byCity.status, 201);

  const byPin = await publish({ pincode: PIN, pricePerUnit: '80.00' });
  equal('a price scoped to a PIN code', byPin.status, 201);
  equal('  which reports its PIN code back', byPin.data?.price?.pincode, PIN);

  const badPin = await publish({ pincode: '12', pricePerUnit: '80.00' });
  equal('a malformed PIN code is refused', badPin.status, 400);

  const past = new Date(Date.now() - 60_000).toISOString();
  const rule = (body) =>
    call('POST', '/admin/delivery-charges', {
      token: adminToken,
      body: { minQuantity: '0', effectiveFrom: past, ...body },
    });

  equal(
    'a delivery rule scoped to the city',
    (await rule({ name: `City ${stamp}`, city: CITY, flatCharge: '700' })).status,
    201
  );
  equal(
    'a delivery rule scoped to the PIN code',
    (await rule({ name: `Pin ${stamp}`, pincode: PIN, flatCharge: '300' })).status,
    201
  );

  // --- A customer with an address in that city ------------------------------
  const phone = `+9193${String(Date.now()).slice(-8)}`;
  await call('POST', '/auth/otp/request', {
    body: { phone, principal: 'CUSTOMER', purpose: 'SIGNUP' },
  });
  const signup = await call('POST', '/auth/otp/verify', {
    body: { phone, principal: 'CUSTOMER', purpose: 'SIGNUP', code: CODE },
  });
  const token = signup.data?.tokens?.accessToken;
  await call('POST', '/customers/register', { token, body: { fullName: 'Scope Probe' } });

  const quoteFor = async (pincode) => {
    const address = await call('POST', '/customers/addresses', {
      token,
      body: {
        line1: 'Site',
        city: CITY,
        state: 'West Bengal',
        pincode,
        latitude: '22.581028',
        longitude: '88.480272',
      },
    });

    const quote = await call('POST', '/quotes', {
      token,
      body: { addressId: address.data?.address?.id, productId: product.id, quantity: '1000' },
    });

    if (quote.status !== 201) return { error: quote.code };

    const lines = quote.data?.quote?.lines ?? [];
    const fuel = lines.find((line) => line.kind === 'FUEL');
    const delivery = lines.find((line) => line.kind === 'DELIVERY');

    return {
      fuel: fuel?.lineTotal,
      deliveryNet: (Number(delivery?.lineTotal) - Number(delivery?.taxAmount)).toFixed(2),
    };
  };

  // --- The PIN code wins ----------------------------------------------------
  section('2. THE PIN CODE WINS OVER THE CITY');

  const atPin = await quoteFor(PIN);
  equal('1000 L is priced at the PIN-code rate', atPin.fuel, '80000.00');
  equal('and charged the PIN-code delivery', atPin.deliveryNet, '300.00');

  section('3. ANOTHER PIN CODE IN THE SAME CITY FALLS BACK TO THE CITY');

  const elsewhere = await quoteFor(OTHER_PIN);
  equal('1000 L is priced at the city rate', elsewhere.fuel, '90000.00');
  equal('and charged the city delivery', elsewhere.deliveryNet, '700.00');

  // --- Publishing is scoped -------------------------------------------------
  section('4. PUBLISHING SUPERSEDES ONLY ITS OWN SCOPE');

  equal('a new PIN-code rate publishes', (await publish({ pincode: PIN, pricePerUnit: '85.00' })).status, 201);

  const afterRepublish = await quoteFor(PIN);
  equal('the PIN-code rate is the new one', afterRepublish.fuel, '85000.00');

  const cityUntouched = await quoteFor(OTHER_PIN);
  equal('the city rate is UNTOUCHED', cityUntouched.fuel, '90000.00');

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('\nHarness error:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
