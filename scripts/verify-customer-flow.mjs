/**
 * End-to-end verification of the CUSTOMER API surface.
 *
 * Every request below is the exact path, body and header the Flutter customer
 * app sends, and every assertion is a field one of its Dart models parses. A
 * compiler cannot check a wire shape; this can.
 *
 *   node scripts/verify-customer-flow.mjs
 *
 * Requires the server running on PORT and `node scripts/seed-pricing.js`.
 */
import { prisma } from '../src/infrastructure/database/prisma.js';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1';

let passed = 0;
let failed = 0;
const failures = [];

const ok = (label) => {
  passed += 1;
  console.log(`  [32mPASS[0m ${label}`);
};

const bad = (label, detail) => {
  failed += 1;
  failures.push(`${label}\n       ${detail}`);
  console.log(`  [31mFAIL[0m ${label}\n       ${detail}`);
};

const check = (label, condition, detail = '') => {
  if (condition) ok(label);
  else bad(label, detail);
};

const equal = (label, actual, expected) =>
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

/** The app's ApiClient: unwraps `data`, treats `success !== true` as an error. */
async function call(method, path, { body, token, headers = {} } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload = await response.json().catch(() => null);

  return {
    status: response.status,
    body: payload,
    data: payload?.data,
    code: payload?.error?.code,
    message: payload?.message,
  };
}

const section = (title) => console.log(`\n[1m${title}[0m`);

// A fresh number each run, so signup is genuinely a first run.
const PHONE = `+919${String(Date.now()).slice(-9)}`;

async function main() {
  console.log(`Verifying the customer flow against ${BASE}`);
  console.log(`Test number: ${PHONE}\n`);

  // --- 1. Sign in ------------------------------------------------------------
  section('1. OTP sign-in (login_screen.dart)');

  const request = await call('POST', '/auth/otp/request', {
    body: { phone: PHONE, principal: 'CUSTOMER', purpose: 'SIGNUP' },
  });

  equal('POST /auth/otp/request returns 202', request.status, 202);
  check('the dev provider returns devCode', Boolean(request.data?.devCode), JSON.stringify(request.data));

  const verify = await call('POST', '/auth/otp/verify', {
    body: {
      phone: PHONE,
      principal: 'CUSTOMER',
      purpose: 'SIGNUP',
      code: request.data.devCode,
    },
  });

  equal('POST /auth/otp/verify succeeds', verify.status, 200);
  check(
    'tokens are at data.tokens.{accessToken,refreshToken}',
    Boolean(verify.data?.tokens?.accessToken && verify.data?.tokens?.refreshToken),
    JSON.stringify(Object.keys(verify.data ?? {}))
  );

  let token = verify.data.tokens.accessToken;
  const refreshToken = verify.data.tokens.refreshToken;

  // --- 2. Profile ------------------------------------------------------------
  section('2. Profile (CustomerProfile.fromJson)');

  const register = await call('POST', '/customers/register', { token, body: {} });
  equal('POST /customers/register returns 201', register.status, 201);
  check('the profile is at data.profile', Boolean(register.data?.profile), JSON.stringify(Object.keys(register.data ?? {})));

  const duplicate = await call('POST', '/customers/register', { token, body: {} });
  check(
    'a second register conflicts, as the login screen expects',
    duplicate.status === 409,
    `got ${duplicate.status} ${duplicate.code}`
  );

  const me = await call('GET', '/customers/me', { token });
  const profile = me.data?.profile;

  equal('GET /customers/me returns 200', me.status, 200);
  check('data.profile exists (NOT data.customer)', Boolean(profile), JSON.stringify(Object.keys(me.data ?? {})));
  check('id and userId are present', Boolean(profile?.id && profile?.userId), JSON.stringify(profile));
  equal('phone is FLAT, not nested under user', profile?.phone, PHONE);
  check('user is NOT a nested object', profile?.user === undefined, 'a nested `user` appeared');
  check(
    'marketingOptIn is nested under preferences',
    typeof profile?.preferences?.marketingOptIn === 'boolean',
    JSON.stringify(profile?.preferences)
  );

  const named = await call('PATCH', '/customers/me', {
    token,
    body: { fullName: 'Ramesh Kumar', marketingOptIn: true },
  });

  equal('PATCH /customers/me returns 200', named.status, 200);
  equal('fullName round-trips', named.data?.profile?.fullName, 'Ramesh Kumar');
  equal('marketingOptIn round-trips', named.data?.profile?.preferences?.marketingOptIn, true);

  // --- 3. Addresses ----------------------------------------------------------
  section('3. Addresses (Address.fromJson)');

  const numericCoords = await call('POST', '/customers/addresses', {
    token,
    body: {
      line1: 'Plot 14, MIDC Bhosari',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411026',
      latitude: 18.62,
      longitude: 73.85,
    },
  });

  check(
    'NUMERIC coordinates are REJECTED (this was a real bug)',
    numericCoords.status === 400,
    `got ${numericCoords.status}; a Dart double would have shipped broken`
  );

  const created = await call('POST', '/customers/addresses', {
    token,
    body: {
      nickname: 'Bhosari site',
      line1: 'Plot 14, MIDC Bhosari',
      line2: 'Near Gate 2',
      landmark: 'Opposite the weighbridge',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411026',
      latitude: '18.620000',
      longitude: '73.850000',
      deliveryInstructions: 'Gate 2. Security pass needed. Ask for the site engineer.',
      contactName: 'Site Engineer',
      contactPhone: '+919812345678',
      isDefault: true,
    },
  });

  const address = created.data?.address;

  equal('POST /customers/addresses with STRING coordinates returns 201', created.status, 201);
  check('the address is at data.address', Boolean(address), JSON.stringify(created.body));
  equal('nickname round-trips', address?.nickname, 'Bhosari site');
  equal('the first address becomes the default', address?.isDefault, true);
  check(
    'deliveryInstructions round-trip',
    address?.deliveryInstructions?.startsWith('Gate 2'),
    JSON.stringify(address?.deliveryInstructions)
  );
  check(
    'latitude survives as a decimal string',
    typeof address?.latitude === 'string' || typeof address?.latitude === 'number',
    `type ${typeof address?.latitude}`
  );

  const list = await call('GET', '/customers/addresses', { token });
  equal('GET /customers/addresses returns 200', list.status, 200);
  check('the list is at data.addresses', Array.isArray(list.data?.addresses), JSON.stringify(Object.keys(list.data ?? {})));

  // --- 4. Quote --------------------------------------------------------------
  section('4. Quote (Quote.fromJson, QuoteLine.fromJson)');

  // The app DISCOVERS the product rather than being compiled with its id.
  //
  // There was no customer-facing product listing at all — only
  // `GET /admin/pricing/products` — so the app had to be built with
  // `--dart-define=FUEL_PRODUCT_ID`. Ids differ per database, so an APK built
  // for one environment told customers "this build has no fuel product
  // configured" the moment it was pointed at another.
  const catalogue = await call('GET', '/products', { token });
  equal('GET /products returns 200 for a customer', catalogue.status, 200);

  const listed = catalogue.data?.products ?? [];
  check('it lists at least one orderable product', listed.length > 0, 'empty catalogue');
  check(
    'each carries the id the quote needs, and a name to show',
    listed.every((p) => Boolean(p.id) && Boolean(p.name) && Boolean(p.code)),
    JSON.stringify(listed[0])
  );
  check(
    'and nothing archived or inactive is offered',
    listed.every((p) => p.status === undefined && p.isArchived === undefined),
    'admin-only fields leaked into the customer projection'
  );

  const anonymous = await call('GET', '/products');
  equal('the catalogue still requires a session', anonymous.status, 401);

  const product = await prisma.fuelProduct.findUnique({
    where: { code: 'HSD' },
    select: { id: true },
  });

  equal('the listed product is the one a quote resolves', listed[0]?.id, product.id);

  const tooSmall = await call('POST', '/quotes', {
    token,
    body: { addressId: address.id, productId: product.id, quantity: '20' },
  });

  equal('20 L is refused below the minimum', tooSmall.code, 'BELOW_MINIMUM_ORDER_QUANTITY');
  check(
    'the refusal names the real minimum, so the app need not hardcode it',
    /100/.test(tooSmall.message ?? ''),
    JSON.stringify(tooSmall.message)
  );

  const malformed = await call('POST', '/quotes', {
    token,
    body: { addressId: address.id, productId: product.id, quantity: '200.' },
  });

  check(
    'a half-typed "200." is refused (the app normalises this away)',
    malformed.status === 400,
    `got ${malformed.status}`
  );

  const quoted = await call('POST', '/quotes', {
    token,
    body: { addressId: address.id, productId: product.id, quantity: '200' },
  });

  const quote = quoted.data?.quote;

  equal('POST /quotes returns 201', quoted.status, 201);
  check('the quote is at data.quote', Boolean(quote), JSON.stringify(quoted.body));
  check('money is a STRING on the wire', typeof quote?.totalAmount === 'string', `type ${typeof quote?.totalAmount}`);
  check(
    'pricePerUnit is nested under priceVersion',
    Boolean(quote?.priceVersion?.pricePerUnit),
    JSON.stringify(quote?.priceVersion)
  );
  check('isExpired is present', typeof quote?.isExpired === 'boolean', JSON.stringify(quote?.isExpired));
  check('expiresAt is present', Boolean(quote?.expiresAt), JSON.stringify(quote?.expiresAt));

  const fuel = quote.lines.find((line) => line.kind === 'FUEL');
  const delivery = quote.lines.find((line) => line.kind === 'DELIVERY');

  check('lines carry `description`, NOT `label`', typeof fuel?.description === 'string', JSON.stringify(Object.keys(fuel ?? {})));
  check('lines carry `isInclusive`', typeof fuel?.isInclusive === 'boolean', JSON.stringify(fuel?.isInclusive));
  check('lines carry `taxableAmount`, NOT `netAmount`', 'taxableAmount' in (fuel ?? {}), JSON.stringify(Object.keys(fuel ?? {})));
  check('lines carry `taxComponents`, NOT `taxRate`', Array.isArray(fuel?.taxComponents), JSON.stringify(fuel?.taxComponents));

  equal('the fuel line is INCLUSIVE', fuel?.isInclusive, true);
  equal('the fuel regime is VAT_EXCISE, not NON_GST', fuel?.regime, 'VAT_EXCISE');
  equal('the fuel line carries an HSN code', fuel?.hsnCode, '27101944');
  equal('the delivery line is EXCLUSIVE', delivery?.isInclusive, false);
  equal('the delivery regime is GST', delivery?.regime, 'GST');
  equal('the delivery line carries a SAC code', delivery?.sacCode, '996511');

  const percentageRate = (delivery?.taxComponents ?? [])
    .filter((c) => c.calculationType === 'PERCENTAGE')
    .reduce((total, c) => total + Number(c.rate), 0);

  equal('CGST + SGST sum to the 18% the customer is shown', percentageRate, 18);

  // THE arithmetic rule the whole platform depends on.
  const lineSum = quote.lines.reduce((total, line) => total + Number(line.lineTotal), 0);

  equal('total === sum of lineTotals', Number(quote.totalAmount), lineSum);
  check(
    'adding the taxAmount memo would OVERCHARGE',
    Number(quote.totalAmount) + Number(quote.taxAmount) !== Number(quote.totalAmount),
    'the memo is zero, so this cannot be demonstrated'
  );
  equal('200 L quotes at the documented 19,135.00', quote.totalAmount, '19135.00');
  equal('the fuel line is 18,840.00', fuel?.lineTotal, '18840.00');
  equal('the delivery line is 295.00 (250 + 45 GST)', delivery?.lineTotal, '295.00');

  // --- 5. Place the order ----------------------------------------------------
  section('5. Place order (idempotency, CustomerOrder.fromJson)');

  const noKey = await call('POST', '/orders', {
    token,
    body: { quoteId: quote.id, paymentMode: 'CASH_ON_DELIVERY', acknowledgeDuplicate: false },
  });

  check('POST /orders without Idempotency-Key is refused', noKey.status >= 400, `got ${noKey.status}`);

  const idempotencyKey = crypto.randomUUID();

  const placed = await call('POST', '/orders', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      quoteId: quote.id,
      paymentMode: 'CASH_ON_DELIVERY',
      deliveryInstructions: 'Gate 2. Security pass needed.',
      acknowledgeDuplicate: false,
    },
  });

  const order = placed.data?.order;

  equal('POST /orders returns 201', placed.status, 201);
  check('the order is at data.order', Boolean(order), JSON.stringify(placed.body));
  check('orderNumber is present', Boolean(order?.orderNumber), JSON.stringify(order?.orderNumber));
  equal('the total carries over from the quote', order?.totalAmount, '19135.00');
  equal('deliveredQuantity is null before delivery', order?.deliveredQuantity, null);
  check('deliveryAddress is present on the DETAIL shape', Boolean(order?.deliveryAddress), JSON.stringify(Object.keys(order ?? {})));
  check('breakdown.lines is present on the DETAIL shape', Array.isArray(order?.breakdown?.lines), JSON.stringify(order?.breakdown));
  check('assignment is ABSENT — no driver or vehicle for customers', order?.assignment === undefined, JSON.stringify(order?.assignment));

  const replay = await call('POST', '/orders', {
    token,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: {
      quoteId: quote.id,
      paymentMode: 'CASH_ON_DELIVERY',
      deliveryInstructions: 'Gate 2. Security pass needed.',
      acknowledgeDuplicate: false,
    },
  });

  equal('a replayed key returns the SAME order, not a second one', replay.data?.order?.id, order.id);
  equal('the replay carries the original 201', replay.status, 201);

  const reuseQuote = await call('POST', '/orders', {
    token,
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: { quoteId: quote.id, paymentMode: 'CASH_ON_DELIVERY', acknowledgeDuplicate: true },
  });

  equal('a spent quote with a NEW key is refused', reuseQuote.code, 'QUOTE_ALREADY_USED');

  // --- 6. Read back ----------------------------------------------------------
  section('6. Orders list and detail (the lean-summary constraint)');

  const orders = await call('GET', '/orders', { token, body: undefined });
  const summary = orders.data?.orders?.[0];

  equal('GET /orders returns 200', orders.status, 200);
  check('the list is at data.orders', Array.isArray(orders.data?.orders), JSON.stringify(Object.keys(orders.data ?? {})));
  check(
    'a LIST row has NO deliveryAddress (why reorder refetches)',
    summary?.deliveryAddress === undefined,
    'the summary carried an address after all'
  );
  check('a LIST row has NO breakdown', summary?.breakdown === undefined, 'the summary carried a breakdown');
  check('a LIST row DOES carry city (the placeLabel fallback)', typeof summary?.city === 'string', JSON.stringify(summary?.city));
  check('a LIST row carries quantity and totalAmount', Boolean(summary?.quantity && summary?.totalAmount), JSON.stringify(summary));

  const detail = await call('GET', `/orders/${order.id}`, { token });
  equal('GET /orders/:id returns 200', detail.status, 200);
  check('the detail carries deliveryAddress', Boolean(detail.data?.order?.deliveryAddress), 'missing');

  const history = await call('GET', `/orders/${order.id}/history`, { token });
  equal('GET /orders/:id/history returns 200', history.status, 200);
  check('the timeline is at data.timeline', Array.isArray(history.data?.timeline), JSON.stringify(Object.keys(history.data ?? {})));

  const event = history.data?.timeline?.[0];
  check('timeline entries carry status and occurredAt', Boolean(event?.status && event?.occurredAt), JSON.stringify(event));
  check('timeline entries carry NO metadata for customers', event?.metadata === undefined, JSON.stringify(event?.metadata));

  // --- 7. Cancel -------------------------------------------------------------
  section('7. Cancel (BR-1201/1206)');

  const noReason = await call('POST', `/orders/${order.id}/cancel`, { token, body: { reason: 'no' } });
  check('a reason under 3 characters is refused', noReason.status === 400, `got ${noReason.status}`);

  const cancelled = await call('POST', `/orders/${order.id}/cancel`, {
    token,
    body: { reason: 'No longer need the fuel' },
  });

  equal('POST /orders/:id/cancel returns 200', cancelled.status, 200);
  equal('the order is CANCELLED_BY_CUSTOMER', cancelled.data?.order?.status, 'CANCELLED_BY_CUSTOMER');
  check(
    'the cancellation reason is readable back',
    cancelled.data?.order?.cancellation?.reason === 'No longer need the fuel',
    JSON.stringify(cancelled.data?.order?.cancellation)
  );

  const twice = await call('POST', `/orders/${order.id}/cancel`, { token, body: { reason: 'Changed my mind' } });
  check('cancelling twice is refused', twice.status >= 400, `got ${twice.status}`);

  // --- 8. Session ------------------------------------------------------------
  section('8. Session (ApiClient refresh)');

  const refreshed = await call('POST', '/auth/refresh', { body: { refreshToken } });
  equal('POST /auth/refresh returns 200', refreshed.status, 200);
  check(
    'refresh returns a NEW pair at data.tokens',
    Boolean(refreshed.data?.tokens?.accessToken) && refreshed.data.tokens.refreshToken !== refreshToken,
    'the refresh token did not rotate'
  );

  token = refreshed.data.tokens.accessToken;

  const afterRefresh = await call('GET', '/customers/me', { token });
  equal('the new access token works', afterRefresh.status, 200);

  const replayed = await call('POST', '/auth/refresh', { body: { refreshToken } });
  check(
    'replaying the OLD refresh token is refused (rotation is enforced)',
    replayed.status === 401,
    `got ${replayed.status} ${replayed.code}`
  );

  const noToken = await call('GET', '/customers/me');
  equal('an unauthenticated read is 401', noToken.status, 401);

  // --- Summary ---------------------------------------------------------------
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
