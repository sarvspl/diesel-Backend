import '../helpers/env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * Fleet domain, end to end against a real database.
 *
 * SKIPPED unless TEST_DATABASE_URL is set. Requires the migration AND the seed.
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);

if (enabled) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

describe(
  'fleet domain (integration)',
  { skip: enabled ? false : 'TEST_DATABASE_URL not set' },
  () => {
    let server;
    let baseUrl;
    let prisma;
    let adminToken;

    const stamp = String(Date.now()).slice(-8);
    const adminEmail = `fleet.admin.${stamp}@example.test`;
    const adminPassword = 'a-sufficiently-long-admin-password';
    const driverPhone = `+9193${stamp}`;
    const driver2Phone = `+9192${stamp}`;
    const vehicleNumber = `TKR-${stamp}`;
    const registrationNumber = `WB12AB${stamp}`;

    const call = async (path, { method = 'GET', body, token = adminToken } = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      return { status: response.status, body: await response.json() };
    };

    before(async () => {
      const { createApp } = await import('../../src/app.js');
      ({ prisma } = await import('../../src/infrastructure/database/prisma.js'));
      await prisma.$connect();

      server = createApp().listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

      const { hashPassword } =
        await import('../../src/modules/identity/services/password.service.js');
      const role = await prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' } });
      assert.ok(role, 'seed must have run: SUPER_ADMIN role missing');

      await prisma.user.create({
        data: {
          principal: 'ADMIN',
          email: adminEmail,
          passwordHash: await hashPassword(adminPassword),
          emailVerifiedAt: new Date(),
          roles: { create: { roleId: role.id } },
        },
      });

      const login = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'ADMIN', email: adminEmail, password: adminPassword },
        token: null,
      });

      assert.equal(login.status, 200);
      adminToken = login.body.data.tokens.accessToken;
    });

    after(async () => {
      if (prisma) {
        await prisma.vehicle.deleteMany({ where: { vehicleNumber } });
        await prisma.user.deleteMany({
          where: { OR: [{ phone: { in: [driverPhone, driver2Phone] } }, { email: adminEmail }] },
        });
        await prisma.$disconnect();
      }
      server?.close();
    });

    // --- Driver profiles ---------------------------------------------------

    let driverProfileId;
    let driver2ProfileId;

    const createDriverIdentity = async (phone) => {
      const user = await prisma.user.create({
        data: { principal: 'DRIVER', phone, phoneVerifiedAt: new Date() },
        select: { id: true },
      });

      return user.id;
    };

    it('creates a driver profile for an existing DRIVER identity', async () => {
      const userId = await createDriverIdentity(driverPhone);

      const { status, body } = await call('/admin/drivers/profile', {
        method: 'POST',
        body: {
          userId,
          fullName: 'Ramesh Kumar',
          employeeCode: `EMP-${stamp}`,
          licenseNumber: 'WB1220190001234',
          licenseExpiry: '2028-06-30',
          joinedOn: '2026-01-15',
        },
      });

      assert.equal(status, 201);
      assert.equal(body.data.driver.fullName, 'Ramesh Kumar');
      assert.equal(body.data.driver.employmentStatus, 'ACTIVE');
      // Two orthogonal axes (ADR-007).
      assert.equal(body.data.driver.availability, 'OFFLINE');
      assert.equal(body.data.driver.license.isExpired, false);
      assert.equal(body.data.driver.phone, driverPhone, 'phone is read from users, not duplicated');

      driverProfileId = body.data.driver.id;
    });

    it('refuses a driver profile for a CUSTOMER identity', async () => {
      const customer = await prisma.user.create({
        data: { principal: 'CUSTOMER', phone: `+9191${stamp}` },
        select: { id: true },
      });

      const { status, body } = await call('/admin/drivers/profile', {
        method: 'POST',
        body: { userId: customer.id, fullName: 'Not a driver' },
      });

      assert.equal(status, 400);
      assert.equal(body.error.code, 'WRONG_PRINCIPAL');

      await prisma.user.delete({ where: { id: customer.id } });
    });

    it('refuses a duplicate driver profile', async () => {
      const existing = await prisma.driverProfile.findUnique({ where: { id: driverProfileId } });

      const { status, body } = await call('/admin/drivers/profile', {
        method: 'POST',
        body: { userId: existing.userId, fullName: 'Duplicate' },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'PROFILE_ALREADY_EXISTS');
    });

    it('never returns a licence number in the list projection', async () => {
      const { status, body } = await call('/admin/drivers');

      assert.equal(status, 200);
      // BR-303: personal data. The list has no need of it.
      assert.ok(!JSON.stringify(body).includes('WB1220190001234'));
    });

    it('patches a driver profile', async () => {
      const { status, body } = await call(`/admin/drivers/${driverProfileId}`, {
        method: 'PATCH',
        body: { fullName: 'Ramesh K.' },
      });

      assert.equal(status, 200);
      assert.equal(body.data.driver.fullName, 'Ramesh K.');
    });

    // --- Vehicles ----------------------------------------------------------

    let vehicleId;

    it('creates a vehicle with an opening balance', async () => {
      const { status, body } = await call('/admin/vehicles', {
        method: 'POST',
        body: {
          vehicleNumber,
          registrationNumber,
          tankCapacity: '12000.000',
          openingFuelQuantity: '4000.000',
          calibrationExpiry: '2028-03-31',
          pesoLicenseExpiry: '2028-03-31',
          insuranceExpiry: '2028-03-31',
          fitnessExpiry: '2028-03-31',
        },
      });

      assert.equal(status, 201);
      assert.equal(body.data.vehicle.inventory.currentQuantity, '4000');
      vehicleId = body.data.vehicle.id;

      // The opening balance must exist in the log, or reconciliation reports
      // every new vehicle as drifted.
      const adjustments = await prisma.inventoryAdjustment.findMany({ where: { vehicleId } });
      assert.equal(adjustments.length, 1);
      assert.equal(adjustments[0].type, 'OPENING_BALANCE');
    });

    it('rejects an opening quantity above the tank capacity', async () => {
      const { status, body } = await call('/admin/vehicles', {
        method: 'POST',
        body: {
          vehicleNumber: `${vehicleNumber}-X`,
          registrationNumber: `${registrationNumber}X`,
          tankCapacity: '1000',
          openingFuelQuantity: '5000',
        },
      });

      assert.equal(status, 400);
      assert.equal(body.error.code, 'EXCEEDS_CAPACITY');
    });

    it('reports dispatchability without a driver', async () => {
      const { body } = await call(`/admin/vehicles/${vehicleId}`);

      assert.equal(body.data.vehicle.dispatchability.dispatchable, false);
      assert.ok(body.data.vehicle.dispatchability.blockers.includes('NO_DRIVER_ASSIGNED'));
      // Soft: an operator can assign someone and proceed.
      assert.equal(body.data.vehicle.dispatchability.hardBlockers.length, 0);
    });

    // --- Assignment --------------------------------------------------------

    it('assigns a driver', async () => {
      const { status, body } = await call(`/admin/vehicles/${vehicleId}/assign-driver`, {
        method: 'POST',
        body: { driverProfileId },
      });

      assert.equal(status, 201);
      assert.equal(body.data.assignment.releasedAt, null);
    });

    it('becomes dispatchable once crewed', async () => {
      const { body } = await call(`/admin/vehicles/${vehicleId}`);

      assert.equal(body.data.vehicle.dispatchability.dispatchable, true);
      assert.equal(body.data.vehicle.currentAssignment.driver.id, driverProfileId);
    });

    it('refuses a second driver on the same vehicle', async () => {
      const userId = await createDriverIdentity(driver2Phone);
      const created = await call('/admin/drivers/profile', {
        method: 'POST',
        body: { userId, fullName: 'Second Driver', licenseExpiry: '2028-06-30' },
      });
      driver2ProfileId = created.body.data.driver.id;

      const { status, body } = await call(`/admin/vehicles/${vehicleId}/assign-driver`, {
        method: 'POST',
        body: { driverProfileId: driver2ProfileId },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'VEHICLE_ALREADY_ASSIGNED');
    });

    it('refuses to give one driver a second vehicle', async () => {
      const other = await call('/admin/vehicles', {
        method: 'POST',
        body: {
          vehicleNumber: `${vehicleNumber}-2`,
          registrationNumber: `${registrationNumber}2`,
          tankCapacity: '8000',
        },
      });

      const { status, body } = await call(
        `/admin/vehicles/${other.body.data.vehicle.id}/assign-driver`,
        { method: 'POST', body: { driverProfileId } }
      );

      assert.equal(status, 409);
      assert.equal(body.error.code, 'DRIVER_ALREADY_ASSIGNED');

      await prisma.vehicle.delete({ where: { id: other.body.data.vehicle.id } });
    });

    // --- Inventory ---------------------------------------------------------

    it('records a refill and moves stock', async () => {
      const { status, body } = await call(`/admin/vehicles/${vehicleId}/refill`, {
        method: 'POST',
        body: {
          quantity: '3000.000',
          depotName: 'IOC Budge Budge',
          invoiceRef: `INV-${stamp}`,
        },
      });

      assert.equal(status, 201);
      assert.equal(body.data.adjustment.quantityBefore, '4000');
      assert.equal(body.data.adjustment.quantityAfter, '7000');
      assert.equal(body.data.adjustment.type, 'REFILL');
    });

    it('refuses a refill that would overflow the tank', async () => {
      const { status, body } = await call(`/admin/vehicles/${vehicleId}/refill`, {
        method: 'POST',
        body: { quantity: '9000.000', depotName: 'IOC Budge Budge' },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'EXCEEDS_CAPACITY');
    });

    it('records a manual decrease with a reason', async () => {
      const { status, body } = await call(`/admin/vehicles/${vehicleId}/manual-adjustment`, {
        method: 'POST',
        body: {
          direction: 'DECREASE',
          quantity: '50.000',
          reasonCode: 'LEAK_DETECTED',
          reason: 'Seal failure on compartment 2 found during the morning inspection.',
        },
      });

      assert.equal(status, 201);
      assert.equal(body.data.adjustment.quantityDelta, '-50');
      assert.equal(body.data.adjustment.quantityAfter, '6950');
      // Every adjustment records who did it.
      assert.ok(body.data.adjustment.performedByUserId);
    });

    it('refuses an unexplained manual adjustment', async () => {
      const { status } = await call(`/admin/vehicles/${vehicleId}/manual-adjustment`, {
        method: 'POST',
        body: { direction: 'DECREASE', quantity: '10' },
      });

      assert.equal(status, 400);
    });

    it('refuses to remove more fuel than the vehicle holds', async () => {
      const { status, body } = await call(`/admin/vehicles/${vehicleId}/manual-adjustment`, {
        method: 'POST',
        body: {
          direction: 'DECREASE',
          quantity: '99000.000',
          reasonCode: 'TEST_OVERDRAW',
          reason: 'Attempting to remove more fuel than the tanker contains.',
        },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'INSUFFICIENT_FUEL');
    });

    it('the cached quantity equals the sum of the adjustment log', async () => {
      const { reconcileInventory } =
        await import('../../src/modules/fleet/services/inventory.service.js');

      const result = await reconcileInventory(vehicleId);

      // The fuel analogue of INV-02. Drift means something wrote the cache
      // directly, which no code path is allowed to do.
      assert.equal(
        result.drift,
        0,
        `cache ${result.cachedQuantity} vs log ${result.ledgerQuantity}`
      );
    });

    // --- Meter readings ----------------------------------------------------

    it('records a meter reading', async () => {
      const { status, body } = await call(`/admin/vehicles/${vehicleId}/meter-reading`, {
        method: 'POST',
        body: { totalizer: '100000.000', photoKey: 'meter/a.jpg' },
      });

      assert.equal(status, 201);
      assert.equal(body.data.reading.totalizer, '100000');
      assert.equal(body.data.reading.source, 'MANUAL_ENTRY');
    });

    it('refuses a reading below the last one (BR-903)', async () => {
      const { status, body } = await call(`/admin/vehicles/${vehicleId}/meter-reading`, {
        method: 'POST',
        body: { totalizer: '99999.000', photoKey: 'meter/b.jpg' },
      });

      assert.equal(status, 400);
      assert.equal(body.error.code, 'METER_READING_REGRESSION');
    });

    it('refuses a manual reading with no photograph (BR-906)', async () => {
      const { status } = await call(`/admin/vehicles/${vehicleId}/meter-reading`, {
        method: 'POST',
        body: { totalizer: '100500.000' },
      });

      assert.equal(status, 400);
    });

    it('a meter reading does not move stock (BR-404)', async () => {
      const before = await prisma.vehicleInventory.findUnique({ where: { vehicleId } });

      await call(`/admin/vehicles/${vehicleId}/meter-reading`, {
        method: 'POST',
        body: { totalizer: '100600.000', photoKey: 'meter/c.jpg' },
      });

      const after = await prisma.vehicleInventory.findUnique({ where: { vehicleId } });

      // A meter counts what was dispensed; it does not know what is left.
      assert.equal(String(before.currentQuantity), String(after.currentQuantity));
    });

    // --- Shifts ------------------------------------------------------------

    let shiftId;

    it('starts a shift', async () => {
      const { status, body } = await call('/admin/shifts/start', {
        method: 'POST',
        body: {
          driverProfileId,
          vehicleId,
          openingTotalizer: '100600.000',
          photoKey: 'meter/shift-open.jpg',
        },
      });

      assert.equal(status, 201);
      assert.equal(body.data.shift.status, 'OPEN');
      assert.equal(body.data.shift.openingMeterReading.totalizer, '100600');
      shiftId = body.data.shift.id;

      // Starting a shift is coming on duty.
      const driver = await prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
      assert.equal(driver.availability, 'ONLINE');
    });

    it('refuses a second open shift for the same driver (INV-07)', async () => {
      const { status, body } = await call('/admin/shifts/start', {
        method: 'POST',
        body: {
          driverProfileId,
          vehicleId,
          openingTotalizer: '100700.000',
          photoKey: 'meter/x.jpg',
        },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'SHIFT_ALREADY_OPEN');
    });

    it('refuses to unassign a driver with an open shift', async () => {
      const { status, body } = await call(`/admin/vehicles/${vehicleId}/unassign-driver`, {
        method: 'POST',
        body: { reason: 'Test' },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'VEHICLE_HAS_OPEN_SHIFT');
    });

    it('refuses a closing reading below the opening (BR-903)', async () => {
      const { status, body } = await call('/admin/shifts/end', {
        method: 'POST',
        body: {
          shiftId,
          closingTotalizer: '100000.000',
          photoKey: 'meter/shift-close.jpg',
        },
      });

      assert.equal(status, 400);
      assert.equal(body.error.code, 'METER_READING_REGRESSION');
    });

    it('ends a shift and derives dispensed volume from the two readings', async () => {
      const { status, body } = await call('/admin/shifts/end', {
        method: 'POST',
        body: {
          shiftId,
          closingTotalizer: '101100.000',
          photoKey: 'meter/shift-close.jpg',
        },
      });

      assert.equal(status, 200);
      assert.equal(body.data.shift.status, 'CLOSED');
      // BR-901: derived from two readings, never a typed quantity.
      assert.equal(body.data.shift.dispensedQuantity, '500');

      const driver = await prisma.driverProfile.findUnique({ where: { id: driverProfileId } });
      assert.equal(driver.availability, 'OFFLINE');
    });

    it('refuses to end an already-closed shift', async () => {
      const { status, body } = await call('/admin/shifts/end', {
        method: 'POST',
        body: { shiftId, closingTotalizer: '101200.000', photoKey: 'meter/z.jpg' },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'SHIFT_NOT_OPEN');
    });

    it('blocks a shift for a driver with an expired licence (BR-304)', async () => {
      await prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: { licenseExpiry: new Date('2020-01-01T00:00:00.000Z') },
      });

      const { status, body } = await call('/admin/shifts/start', {
        method: 'POST',
        body: {
          driverProfileId,
          vehicleId,
          openingTotalizer: '101200.000',
          photoKey: 'meter/y.jpg',
        },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'DRIVER_LICENCE_EXPIRED');

      // An expired licence must not delete history.
      const shifts = await prisma.driverShift.count({ where: { driverProfileId } });
      assert.ok(shifts >= 1, 'shift history must survive licence expiry');

      await prisma.driverProfile.update({
        where: { id: driverProfileId },
        data: { licenseExpiry: new Date('2028-06-30T00:00:00.000Z') },
      });
    });

    it('blocks a shift on a vehicle with expired calibration (BR-402)', async () => {
      await prisma.vehicle.update({
        where: { id: vehicleId },
        data: { calibrationExpiry: new Date('2020-01-01T00:00:00.000Z') },
      });

      const { status, body } = await call('/admin/shifts/start', {
        method: 'POST',
        body: {
          driverProfileId,
          vehicleId,
          openingTotalizer: '101200.000',
          photoKey: 'meter/y.jpg',
        },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'VEHICLE_NOT_DISPATCHABLE');
      assert.ok(body.error.details.blockers.includes('CALIBRATION_EXPIRED'));

      await prisma.vehicle.update({
        where: { id: vehicleId },
        data: { calibrationExpiry: new Date('2028-03-31T00:00:00.000Z') },
      });
    });

    // --- Assignment history ------------------------------------------------

    it('keeps assignment history after unassigning', async () => {
      const unassigned = await call(`/admin/vehicles/${vehicleId}/unassign-driver`, {
        method: 'POST',
        body: { reason: 'Rostered onto another vehicle' },
      });
      assert.equal(unassigned.status, 200);

      const { status, body } = await call(`/admin/vehicles/${vehicleId}/history`);

      assert.equal(status, 200);
      assert.equal(body.data.assignments.length, 1);
      assert.ok(
        body.data.assignments[0].releasedAt,
        'the row survives, released rather than deleted'
      );
      assert.equal(body.data.assignments[0].isActive, false);
      assert.equal(body.data.assignments[0].releaseReason, 'Rostered onto another vehicle');
    });

    it('allows reassignment once released', async () => {
      const { status } = await call(`/admin/vehicles/${vehicleId}/assign-driver`, {
        method: 'POST',
        body: { driverProfileId: driver2ProfileId },
      });

      assert.equal(status, 201);

      const history = await call(`/admin/vehicles/${vehicleId}/history`);
      assert.equal(history.body.data.assignments.length, 2, 'history is append-only');
    });

    // --- Authorization -----------------------------------------------------

    it('refuses fleet endpoints without a token', async () => {
      const { status } = await call('/admin/vehicles', { token: null });

      assert.equal(status, 401);
    });

    it('refuses fleet endpoints to a customer token', async () => {
      const customerPhone = `+9190${stamp}`;
      const requested = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: customerPhone, principal: 'CUSTOMER', purpose: 'SIGNUP' },
        token: null,
      });
      const verified = await call('/auth/otp/verify', {
        method: 'POST',
        body: {
          phone: customerPhone,
          principal: 'CUSTOMER',
          purpose: 'SIGNUP',
          code: requested.body.data.devCode,
        },
        token: null,
      });

      const { status, body } = await call('/admin/vehicles', {
        token: verified.body.data.tokens.accessToken,
      });

      assert.equal(status, 403);
      assert.equal(body.error.code, 'WRONG_PRINCIPAL');

      await prisma.otpChallenge.deleteMany({ where: { identifier: customerPhone } });
      await prisma.user.deleteMany({ where: { phone: customerPhone } });
    });
  }
);
