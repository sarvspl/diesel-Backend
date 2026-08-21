/**
 * End-to-end: a delivery on an IoT-monitored tanker takes its opening and
 * closing readings from the device (mock STOCK provider) and bills the drop,
 * exercising the REAL delivery service + prisma + the reading CHECK constraints.
 * No driver typing, no photo.
 *
 *   FLOW_METER_PROVIDER=mock node scripts/verify-delivery-device.mjs
 */
// Set BEFORE importing anything that reads it. Static `import` statements are
// hoisted above top-level code, and env.js parses process.env at import time,
// so the config would otherwise be read as `manual` before this line runs.
// Dynamic imports below run AFTER it — and it means a plain `node scripts/...`
// works on Windows PowerShell too, with no `VAR=value` prefix (which is
// Unix-only) and no cross-env dependency.
process.env.FLOW_METER_PROVIDER = process.env.FLOW_METER_PROVIDER ?? 'mock';

const { randomUUID } = await import('node:crypto');
const { prisma } = await import('../src/infrastructure/database/prisma.js');
const { startDispensing, completeDelivery } = await import(
  '../src/modules/driver/services/delivery.service.js'
);

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { if (c) { pass++; console.log('  PASS', l); } else { fail++; console.log('  FAIL', l, '\n       ', d); } };
const eq = (l, a, e) => ok(l, a === e, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

async function main() {
  // A vehicle that (a) is on an order's reservation and (b) has an active driver.
  const assignment = await prisma.vehicleAssignment.findFirst({
    where: {
      releasedAt: null,
      vehicle: { reservations: { some: {} } },
    },
    select: { vehicleId: true, driverProfile: { select: { id: true, userId: true } } },
  });

  if (!assignment) { console.log('No assigned vehicle with a reservation. Run seed:operations.'); process.exit(1); }

  const { vehicleId } = assignment;
  const driverProfileId = assignment.driverProfile.id;
  const userId = assignment.driverProfile.userId;

  const order = await prisma.order.findFirst({
    where: { reservations: { some: { vehicleId } } },
    orderBy: { placedAt: 'asc' },
    select: { id: true, status: true, quantity: true },
  });

  // --- fixture reset: monitored tanker, order ARRIVED, reservation HELD ------
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { flowMeterEnabled: true } });
  await prisma.meterReading.deleteMany({ where: { vehicleId } });
  await prisma.driverShift.updateMany({ where: { driverProfileId, status: 'OPEN' }, data: { status: 'CLOSED', endedAt: new Date() } });
  const before = (await prisma.order.findUnique({ where: { id: order.id }, select: { status: true } })).status;
  await prisma.order.update({ where: { id: order.id }, data: { status: 'ARRIVED', deliveredQuantity: null, settlementStatus: 'NOT_REQUIRED' } });
  if (before !== 'ARRIVED') {
    await prisma.orderStatusEvent.create({ data: { orderId: order.id, fromStatus: before, toStatus: 'ARRIVED', actorKind: 'SYSTEM', actorUserId: null, reason: 'device delivery test fixture', occurredAt: new Date() } });
  }
  await prisma.fuelReservation.updateMany({ where: { orderId: order.id }, data: { status: 'HELD', releasedAt: null, releaseReason: null } });

  console.log('\n1. OPENING READING FROM THE DEVICE (no typed value, no photo)');
  await startDispensing({ userId, orderId: order.id, receiverVerification: { method: 'OTP' }, requestId: randomUUID() });
  const opening = await prisma.meterReading.findFirst({ where: { orderId: order.id, readingType: 'DELIVERY_START' } });
  ok('opening reading recorded', Boolean(opening));
  eq('  source is FLOW_METER_API', opening?.source, 'FLOW_METER_API');
  ok('  it is a STOCK reading (stock set, totaliser null)', opening?.stockLitres != null && opening?.totalizer === null, JSON.stringify({ s: opening?.stockLitres, t: opening?.totalizer }));
  ok('  no photo required', opening?.photoKey === null);

  console.log('\n2. CLOSING READING FROM THE DEVICE → delivered = stock drop');
  const res = await completeDelivery({ userId, orderId: order.id, clientDeliveryId: randomUUID(), outcome: 'FULL', requestId: randomUUID() });
  const closing = await prisma.meterReading.findFirst({ where: { orderId: order.id, readingType: 'DELIVERY_END' } });
  ok('closing reading recorded', Boolean(closing));
  eq('  source is FLOW_METER_API', closing?.source, 'FLOW_METER_API');
  ok('  it is a STOCK reading', closing?.stockLitres != null && closing?.totalizer === null);

  const expected = Number(opening.stockLitres) - Number(closing.stockLitres);
  ok('  delivered = opening stock − closing stock', Number(closing.grossQuantity) === expected, `${closing.grossQuantity} vs ${expected}`);
  ok('  delivered is positive', expected > 0, String(expected));

  const ord = await prisma.order.findUnique({ where: { id: order.id }, select: { deliveredQuantity: true, status: true } });
  ok('the order carries the delivered quantity', ord.deliveredQuantity != null && Number(ord.deliveredQuantity) === expected, JSON.stringify(ord));
  ok('  and moved to a delivered state', ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(ord.status), ord.status);

  // cleanup: turn the flag back off so we don't disturb other fixtures
  await prisma.vehicle.update({ where: { id: vehicleId }, data: { flowMeterEnabled: false } });

  console.log(`\n${'-'.repeat(56)}\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => { console.error('Harness error:', e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
