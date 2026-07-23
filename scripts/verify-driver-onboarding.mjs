/**
 * End-to-end verification of ADMIN DRIVER ONBOARDING.
 *
 * The point of this endpoint is that an administrator can create a driver who
 * can then actually sign in. So this does not stop at a 201 — it takes the
 * newly created driver all the way through the driver app's own login flow.
 * A "created" driver who cannot log in is not onboarded.
 *
 *   node scripts/verify-driver-onboarding.mjs
 *
 * Requires the server running on PORT, and OTP_INSECURE_FIXED_CODE set (or a
 * dev environment) so the sign-in half can complete.
 */
import { prisma } from '../src/infrastructure/database/prisma.js';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4000/api/v1';

let passed = 0;
let failed = 0;
const failures = [];

const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  [32mPASS[0m ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${label}\n       ${detail}`);
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
  return { status: response.status, body: payload, data: payload?.data, code: payload?.error?.code };
}

// A fresh number each run so onboarding is genuinely a first-time create.
const PHONE = `+919${String(Date.now()).slice(-9)}`;

async function main() {
  console.log(`Verifying driver onboarding against ${BASE}`);
  console.log(`New driver's number: ${PHONE}\n`);

  // --- An administrator to act as -------------------------------------------
  const { signAccessToken } = await import('../src/modules/identity/services/token.service.js');

  // The repository's own loader and flattener, rather than a hand-written
  // include that can silently disagree with the real one — a harness that
  // builds its token differently from the app is testing something else.
  const userRepository = await import('../src/modules/identity/repositories/user.repository.js');

  /**
   * An admin that actually holds `driver.manage`.
   *
   * NOT simply the first ADMIN row: this database has a SUPPORT_TEST admin with
   * four permissions alongside a SUPER_ADMIN with all fifty-three, and picking
   * the wrong one produces a 403 that looks exactly like a broken endpoint.
   */
  const candidates = await prisma.user.findMany({
    where: { principal: 'ADMIN' },
    select: { id: true, email: true },
  });

  let found = null;
  let admin = null;
  let roles = [];
  let permissions = [];

  for (const candidate of candidates) {
    const loaded = await userRepository.findByIdWithRoles(candidate.id);
    const flat = userRepository.flattenAuthorisation(loaded);

    if (flat.permissions.includes('driver.manage')) {
      found = candidate;
      admin = loaded;
      ({ roles, permissions } = flat);
      break;
    }
  }

  if (!admin) {
    console.log(
      `No ADMIN holds driver.manage (checked ${candidates.length}). Run \`npm run seed:superadmin\`.`
    );
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  const adminToken = signAccessToken({
    userId: admin.id,
    principal: 'ADMIN',
    sessionId: 'verify-onboarding',
    roles,
    permissions,
  });

  section('PRECONDITIONS');
  check('an ADMIN exists', true, found.email ?? found.id);
  check(
    'the admin holds driver.manage',
    permissions.includes('driver.manage'),
    permissions.filter((p) => p.startsWith('driver')).join(', ') || 'none'
  );

  // --- Authorisation --------------------------------------------------------
  section('AUTHORISATION');

  const anon = await call('POST', '/admin/drivers', {
    body: { phone: PHONE, fullName: 'Should Not Exist' },
  });
  equal('unauthenticated onboarding is refused', anon.status, 401);

  // --- Validation -----------------------------------------------------------
  section('VALIDATION');

  const noName = await call('POST', '/admin/drivers', {
    token: adminToken,
    body: { phone: PHONE },
  });
  equal('a driver with no name is refused', noName.status, 400);

  const badPhone = await call('POST', '/admin/drivers', {
    token: adminToken,
    body: { phone: '12345', fullName: 'Bad Phone' },
  });
  equal('a malformed phone is refused', badPhone.status, 400);

  // --- Onboarding -----------------------------------------------------------
  section('ONBOARDING');

  const created = await call('POST', '/admin/drivers', {
    token: adminToken,
    body: {
      phone: PHONE,
      fullName: 'Test Onboarded Driver',
      employeeCode: `DRV-T${String(Date.now()).slice(-4)}`,
      licenseNumber: 'MH12-2026-0099',
      licenseExpiry: '2030-01-01',
      joinedOn: '2026-07-23',
      emergencyContactName: 'Next Of Kin',
      emergencyContactPhone: '+919812345670',
      notes: 'Created by verify-driver-onboarding.mjs',
    },
  });

  equal('POST /admin/drivers returns 201', created.status, 201);
  check('the driver is at data.driver', Boolean(created.data?.driver), JSON.stringify(created.body)?.slice(0, 200));

  const driver = created.data?.driver;
  equal('fullName round-trips', driver?.fullName, 'Test Onboarded Driver');
  check('a driverProfile id came back', Boolean(driver?.id), JSON.stringify(driver?.id));
  check('a userId came back — the identity was created too', Boolean(driver?.userId), JSON.stringify(driver?.userId));

  // --- The identity it created ----------------------------------------------
  section('THE IDENTITY');

  const user = await prisma.user.findUnique({
    where: { id: driver.userId },
    include: { roles: { include: { role: true } } },
  });

  equal('principal is DRIVER', user?.principal, 'DRIVER');
  equal('phone matches', user?.phone, PHONE);
  equal('account is ACTIVE', user?.status, 'ACTIVE');
  check('the DRIVER role is attached', user?.roles.some((r) => r.role.code === 'DRIVER'), user?.roles.map((r) => r.role.code).join(','));
  check(
    'phone is NOT pre-verified — an admin typing a number proves nothing',
    user?.phoneVerifiedAt === null,
    `phoneVerifiedAt=${user?.phoneVerifiedAt}`
  );
  check('no password was set — drivers are OTP only', user?.passwordHash === null, `passwordHash=${user?.passwordHash}`);

  // --- Conflict -------------------------------------------------------------
  section('DUPLICATES');

  const again = await call('POST', '/admin/drivers', {
    token: adminToken,
    body: { phone: PHONE, fullName: 'Duplicate Attempt' },
  });

  equal('onboarding the same number twice conflicts', again.status, 409);
  equal('with a code the UI can branch on', again.code, 'ACCOUNT_ALREADY_EXISTS');

  const profileCount = await prisma.driverProfile.count({ where: { userId: driver.userId } });
  equal('the failed retry created no second profile', profileCount, 1);

  // --- Atomicity ------------------------------------------------------------
  section('ATOMICITY');

  const orphans = await prisma.user.count({
    where: { principal: 'DRIVER', driverProfile: null },
  });
  check(
    'no DRIVER identity exists without a profile',
    orphans === 0,
    `${orphans} orphaned identit${orphans === 1 ? 'y' : 'ies'} — a half-created driver holds the phone number and cannot be dispatched`
  );

  // --- It appears in the list -----------------------------------------------
  section('VISIBILITY');

  const list = await call('GET', '/admin/drivers?limit=100', { token: adminToken });
  equal('GET /admin/drivers returns 200', list.status, 200);
  check(
    'the new driver appears in the admin list',
    (list.data?.drivers ?? []).some((d) => d.id === driver.id),
    `${(list.data?.drivers ?? []).length} driver(s) returned`
  );

  // --- THE POINT: can they actually sign in? --------------------------------
  section('THE NEW DRIVER CAN SIGN IN');

  const otp = await call('POST', '/auth/otp/request', {
    body: { phone: PHONE, principal: 'DRIVER', purpose: 'LOGIN' },
  });

  equal('OTP request accepted for the new driver', otp.status, 202);

  const code = otp.data?.devCode;
  check('a code is available to the harness', Boolean(code), code ? `code=${code}` : 'no devCode — set OTP_INSECURE_FIXED_CODE');

  if (code) {
    const signIn = await call('POST', '/auth/otp/verify', {
      body: { phone: PHONE, principal: 'DRIVER', purpose: 'LOGIN', code },
    });

    equal('the onboarded driver signs in', signIn.status, 200);
    check('a driver token was issued', Boolean(signIn.data?.tokens?.accessToken), '');
    check('roles include DRIVER', (signIn.data?.roles ?? []).includes('DRIVER'), (signIn.data?.roles ?? []).join(','));

    const driverToken = signIn.data?.tokens?.accessToken;

    if (driverToken) {
      const me = await call('GET', '/driver/me', { token: driverToken });
      equal('GET /driver/me works for them', me.status, 200);
      equal('it returns THEIR profile', me.data?.driver?.id, driver.id);

      // Signing in is what proves control of the number — not the admin form.
      const after = await prisma.user.findUnique({
        where: { id: driver.userId },
        select: { phoneVerifiedAt: true },
      });
      check(
        'the phone became verified only after they signed in',
        after?.phoneVerifiedAt !== null,
        `phoneVerifiedAt=${after?.phoneVerifiedAt}`
      );
    }
  }

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`\nOnboarded driver kept for manual testing: ${PHONE}`);

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
