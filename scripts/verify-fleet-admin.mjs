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

  // --- Reassignment ---------------------------------------------------------
  section('REASSIGN IN ONE STEP');

  // Free driver B up so it can take the vehicle.
  await prisma.driverProfile.update({
    where: { id: b.id },
    data: { employmentStatus: 'ACTIVE' },
  });

  const noReplace = await call('POST', `/admin/vehicles/${v.id}/assign-driver`, {
    driverProfileId: b.id,
  });
  equal(
    'without `replace` an occupied vehicle is still refused',
    noReplace.code,
    'VEHICLE_ALREADY_ASSIGNED'
  );

  const replaced = await call('POST', `/admin/vehicles/${v.id}/assign-driver`, {
    driverProfileId: b.id,
    replace: true,
    reason: 'Driver called in sick',
  });
  equal('with `replace` the swap succeeds', replaced.status, 201);

  const afterSwap = await call('GET', `/admin/vehicles/${v.id}`);
  equal(
    'the vehicle shows the NEW driver',
    afterSwap.data?.vehicle?.currentAssignment?.driver?.id,
    b.id
  );

  // The displaced driver must be free, not stranded on a released assignment.
  const freed = await call('POST', `/admin/vehicles/${other.data.vehicle.id}/assign-driver`, {
    driverProfileId: a.id,
  });
  equal('the displaced driver is free to take another vehicle', freed.status, 201);

  const history = await call('GET', `/admin/vehicles/${v.id}/history`);
  check(
    'the swap left BOTH assignments in history — it is append-only',
    (history.data?.assignments ?? []).length >= 2,
    `${(history.data?.assignments ?? []).length} record(s)`
  );

  // --- Dip reading ----------------------------------------------------------
  section('DIP READING CLEARS STALE FUEL');

  // The vehicle was created with no stock and never verified.
  const stale = await call('GET', `/admin/vehicles/${v.id}`);
  const before = stale.data?.vehicle?.inventory?.currentQuantity ?? '0';

  const agreeing = await call('POST', `/admin/vehicles/${v.id}/dip-reading`, {
    observedQuantity: before,
  });

  equal('a dip that agrees returns 200', agreeing.status, 200);
  equal('and posts NO adjustment — there was no movement', agreeing.data?.adjustment, null);
  equal('variance is zero', agreeing.data?.variance, '0.000');
  check(
    'the staleness deadline moved forward',
    Boolean(agreeing.data?.inventory?.staleAfter) &&
      new Date(agreeing.data.inventory.staleAfter) > new Date(),
    `staleAfter=${agreeing.data?.inventory?.staleAfter}`
  );

  const cleared = await call('GET', `/admin/vehicles/${v.id}`);
  check(
    'FUEL_STATE_STALE is gone',
    !(cleared.data?.vehicle?.dispatchability?.blockers ?? []).includes('FUEL_STATE_STALE'),
    (cleared.data?.vehicle?.dispatchability?.blockers ?? []).join(', ') || 'no blockers'
  );

  const varied = await call('POST', `/admin/vehicles/${v.id}/dip-reading`, {
    observedQuantity: '25.000',
    notes: 'Monthly dip',
  });

  equal('a dip that differs returns 200', varied.status, 200);
  check('and posts an adjustment', Boolean(varied.data?.adjustment), JSON.stringify(varied.data?.adjustment)?.slice(0, 120));
  equal('the variance is reported', varied.data?.variance, '25.000');
  equal('the reason code marks it as a dip', varied.data?.adjustment?.reasonCode, 'DIP_VARIANCE');
  equal('the level becomes what was observed', varied.data?.inventory?.currentQuantity, '25');

  const overfull = await call('POST', `/admin/vehicles/${v.id}/dip-reading`, {
    observedQuantity: '99999',
  });
  equal('more than the tank holds is refused', overfull.code, 'EXCEEDS_CAPACITY');

  // --- Return a vehicle to service -----------------------------------------
  section('UNBLOCK A VEHICLE');

  const toMaintenance = await call('PATCH', `/admin/vehicles/${v.id}`, {
    status: 'MAINTENANCE',
  });
  equal('a vehicle can be taken off the road', toMaintenance.status, 200);

  const blocked = await call('GET', `/admin/vehicles/${v.id}`);
  check(
    'which blocks dispatch',
    (blocked.data?.vehicle?.dispatchability?.blockers ?? []).includes('VEHICLE_NOT_ACTIVE'),
    (blocked.data?.vehicle?.dispatchability?.blockers ?? []).join(', ')
  );

  const backInService = await call('PATCH', `/admin/vehicles/${v.id}`, { status: 'ACTIVE' });
  equal('and returned to service', backInService.status, 200);

  const unblocked = await call('GET', `/admin/vehicles/${v.id}`);
  check(
    'clearing the block again',
    !(unblocked.data?.vehicle?.dispatchability?.blockers ?? []).includes('VEHICLE_NOT_ACTIVE'),
    (unblocked.data?.vehicle?.dispatchability?.blockers ?? []).join(', ') || 'no blockers'
  );

  // --- Revoke a suspension --------------------------------------------------
  section('REVOKE A SUSPENSION');

  const suspend = await call('PATCH', `/admin/drivers/${a.id}`, {
    employmentStatus: 'SUSPENDED',
  });
  equal('a driver can be suspended', suspend.status, 200);
  equal('and reads back as suspended', suspend.data?.driver?.employmentStatus, 'SUSPENDED');

  const reinstate = await call('PATCH', `/admin/drivers/${a.id}`, {
    employmentStatus: 'ACTIVE',
  });
  equal('the suspension can be revoked', reinstate.status, 200);
  equal('and they are active again', reinstate.data?.driver?.employmentStatus, 'ACTIVE');

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
