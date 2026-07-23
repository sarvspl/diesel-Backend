/**
 * End-to-end verification of the ADMIN FLEET loop:
 * onboard a driver → add a vehicle → assign → unassign.
 *
 * These four are one workflow, not four features. A vehicle with no driver
 * cannot be dispatched, and a driver with no vehicle cannot start a shift — so
 * this checks the JOIN between them, including every refusal the admin UI
 * pre-filters for.
 *
 *   node scripts/verify-fleet-admin.mjs
 */
import { prisma } from '../src/infrastructure/database/prisma.js';

const BASE = process.env.API_BASE_URL ?? 'http://localhost:4200/api/v1';

let passed = 0;
let failed = 0;
const failures = [];

const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  [32mPASS[0m ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(`${label}: ${detail}`);
    console.log(`  [31mFAIL[0m ${label}\n       ${detail}`);
  }
};

const equal = (label, actual, expected) =>
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const section = (title) => console.log(`\n[1m${title}[0m`);

let token = '';

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, data: payload?.data, code: payload?.error?.code, body: payload };
}

const stamp = String(Date.now()).slice(-6);

// An Indian mobile is +91 then TEN digits starting 6-9. Built explicitly rather
// than sliced to a length, because getting it one digit short produces a 400
// that reads like a broken endpoint.
const base = String(Date.now()).slice(-8);
const PHONE_A = `+919${base}1`;
const PHONE_B = `+919${base}2`;

async function main() {
  console.log(`Verifying the admin fleet loop against ${BASE}\n`);

  const userRepository = await import('../src/modules/identity/repositories/user.repository.js');
  const { signAccessToken } = await import('../src/modules/identity/services/token.service.js');

  const candidates = await prisma.user.findMany({
    where: { principal: 'ADMIN' },
    select: { id: true, email: true },
  });

  let admin = null;
  for (const candidate of candidates) {
    const loaded = await userRepository.findByIdWithRoles(candidate.id);
    const flat = userRepository.flattenAuthorisation(loaded);
    if (flat.permissions.includes('vehicle.assign') && flat.permissions.includes('driver.manage')) {
      admin = { loaded, flat, email: candidate.email };
      break;
    }
  }

  if (!admin) {
    console.log('No ADMIN holds vehicle.assign + driver.manage. Run `npm run seed:superadmin`.');
    await prisma.$disconnect();
    process.exitCode = 1;
    return;
  }

  token = signAccessToken({
    userId: admin.loaded.id,
    principal: 'ADMIN',
    sessionId: 'verify-fleet',
    roles: admin.flat.roles,
    permissions: admin.flat.permissions,
  });

  section('PRECONDITIONS');
  check('an admin with fleet permissions exists', true, admin.email);

  // --- Onboard two drivers --------------------------------------------------
  section('ONBOARD DRIVERS');

  const driverA = await call('POST', '/admin/drivers', {
    phone: PHONE_A,
    fullName: 'Fleet Test Driver A',
    employeeCode: `FT-A${stamp}`,
  });
  equal('driver A onboarded', driverA.status, 201);

  const driverB = await call('POST', '/admin/drivers', {
    phone: PHONE_B,
    fullName: 'Fleet Test Driver B',
    employeeCode: `FT-B${stamp}`,
  });
  equal('driver B onboarded', driverB.status, 201);

  const a = driverA.data?.driver;
  const b = driverB.data?.driver;

  // --- Add a vehicle --------------------------------------------------------
  section('ADD VEHICLE');

  const vehicle = await call('POST', '/admin/vehicles', {
    vehicleNumber: `TNK-T${stamp}`,
    registrationNumber: `MH12ZZ${stamp.slice(-4)}`,
    makeModel: 'Tata LPT 1613',
    tankCapacity: '6000.000',
    compartmentCount: 2,
    openingFuelQuantity: '0',
  });

  equal('POST /admin/vehicles returns 201', vehicle.status, 201);
  const v = vehicle.data?.vehicle;
  check('the vehicle came back', Boolean(v?.id), JSON.stringify(vehicle.body)?.slice(0, 160));

  if (v) {
    equal('it starts with no driver', v.currentAssignment, null);
    check(
      'and is NOT dispatchable — it has no driver yet',
      v.dispatchability?.dispatchable === false,
      JSON.stringify(v.dispatchability?.blockers)
    );
    check(
      'the blocker names the missing driver',
      (v.dispatchability?.blockers ?? []).includes('NO_DRIVER_ASSIGNED'),
      (v.dispatchability?.blockers ?? []).join(', ')
    );
  }

  const dup = await call('POST', '/admin/vehicles', {
    vehicleNumber: `TNK-T${stamp}`,
    registrationNumber: `MH12ZZ${stamp.slice(-4)}`,
    tankCapacity: '6000.000',
  });
  check('a duplicate registration is refused', dup.status === 409, `status ${dup.status} ${dup.code}`);

  // --- Assign ---------------------------------------------------------------
  section('ASSIGN A DRIVER');

  const assigned = await call('POST', `/admin/vehicles/${v.id}/assign-driver`, {
    driverProfileId: a.id,
  });
  equal('assign returns 201', assigned.status, 201);

  const afterAssign = await call('GET', `/admin/vehicles/${v.id}`);
  equal(
    'the vehicle now shows the driver',
    afterAssign.data?.vehicle?.currentAssignment?.driver?.id,
    a.id
  );
  check(
    'NO_DRIVER_ASSIGNED is cleared',
    !(afterAssign.data?.vehicle?.dispatchability?.blockers ?? []).includes('NO_DRIVER_ASSIGNED'),
    (afterAssign.data?.vehicle?.dispatchability?.blockers ?? []).join(', ') || 'no blockers'
  );

  // --- The refusals the dialog pre-filters for ------------------------------
  section('REFUSALS THE UI PRE-FILTERS FOR');

  const twice = await call('POST', `/admin/vehicles/${v.id}/assign-driver`, {
    driverProfileId: a.id,
  });
  equal('assigning the same driver again is refused', twice.code, 'ASSIGNMENT_UNCHANGED');

  const second = await call('POST', `/admin/vehicles/${v.id}/assign-driver`, {
    driverProfileId: b.id,
  });
  equal('a second driver on one vehicle is refused', second.code, 'VEHICLE_ALREADY_ASSIGNED');

  // Driver A is on this vehicle; a NEW vehicle must not also get them.
  const other = await call('POST', '/admin/vehicles', {
    vehicleNumber: `TNK-U${stamp}`,
    registrationNumber: `MH12YY${stamp.slice(-4)}`,
    tankCapacity: '6000.000',
  });

  const doubleBooked = await call('POST', `/admin/vehicles/${other.data.vehicle.id}/assign-driver`, {
    driverProfileId: a.id,
  });
  equal('one driver on two vehicles is refused', doubleBooked.code, 'DRIVER_ALREADY_ASSIGNED');

  // Suspended drivers cannot hold a vehicle (BR-312).
  await prisma.driverProfile.update({
    where: { id: b.id },
    data: { employmentStatus: 'SUSPENDED' },
  });

  const suspended = await call('POST', `/admin/vehicles/${other.data.vehicle.id}/assign-driver`, {
    driverProfileId: b.id,
  });
  equal('a suspended driver is refused', suspended.code, 'DRIVER_NOT_ACTIVE');

  // --- Unassign -------------------------------------------------------------
  section('UNASSIGN');

  const unassigned = await call('POST', `/admin/vehicles/${v.id}/unassign-driver`, {
    reason: 'Verification harness',
  });
  equal('unassign returns 200', unassigned.status, 200);

  const afterUnassign = await call('GET', `/admin/vehicles/${v.id}`);
  equal('the vehicle has no driver again', afterUnassign.data?.vehicle?.currentAssignment, null);
  check(
    'NO_DRIVER_ASSIGNED is back',
    (afterUnassign.data?.vehicle?.dispatchability?.blockers ?? []).includes('NO_DRIVER_ASSIGNED'),
    (afterUnassign.data?.vehicle?.dispatchability?.blockers ?? []).join(', ')
  );

  const reassigned = await call('POST', `/admin/vehicles/${v.id}/assign-driver`, {
    driverProfileId: a.id,
  });
  equal('the freed driver can be assigned again', reassigned.status, 201);

  // --- What the drivers list shows -----------------------------------------
  section('THE ADMIN LIST');

  const list = await call('GET', '/admin/drivers?limit=100');
  const listed = (list.data?.drivers ?? []).find((d) => d.id === a.id);

  check('the new driver is listed', Boolean(listed), `${(list.data?.drivers ?? []).length} drivers`);
  check(
    'the row carries phone at the TOP level, not nested under user',
    listed?.phone === PHONE_A,
    `phone=${JSON.stringify(listed?.phone)} user=${JSON.stringify(listed?.user)}`
  );
  check(
    'and the licence nested under `license`',
    listed !== undefined && typeof listed.license === 'object',
    JSON.stringify(listed?.license)
  );

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
