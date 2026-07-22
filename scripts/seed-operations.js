import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '#prisma';

/**
 * Fleet and order demo data, for local development and the client walkthrough.
 *
 * Builds the scenario the dispatch board exists to handle:
 *   - vehicles that are dispatchable, and vehicles that are NOT, for each
 *     distinct reason (expired calibration = hard, stale fuel = soft)
 *   - drivers online, on a break, and suspended
 *   - orders sitting in CONFIRMED / ALLOCATING / ALLOCATION_FAILED / ASSIGNED
 *
 * Idempotent. Run `npm run seed:demo` first — this reuses its customers.
 *
 *   npm run seed:operations
 */

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const day = (offset) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date;
};

const money = (n) => n.toFixed(2);

/** [number, registration, model, capacity, status, calibrationDays, pucDays, fuel, staleHours] */
const VEHICLES = [
  ['TNK-01', 'MH12AB1234', 'Tata LPT 1613 · 6,000 L', 6000, 'ACTIVE', 240, 180, 4200, 6],
  ['TNK-02', 'MH12CD5678', 'Ashok Leyland 2820 · 9,000 L', 9000, 'ACTIVE', 400, 300, 7800, 6],
  ['TNK-03', 'MH14EF9012', 'Eicher Pro 3015 · 4,000 L', 4000, 'ACTIVE', 90, 60, 900, 6],
  // Hard blocker: calibration lapsed. Legal Metrology — never overridable.
  ['TNK-04', 'MH12GH3456', 'Tata LPT 1613 · 6,000 L', 6000, 'ACTIVE', -5, 120, 5100, 6],
  // Soft blocker: the fuel reading is stale, so the figure is unverified.
  ['TNK-05', 'MH12JK7890', 'BharatBenz 1917 · 8,000 L', 8000, 'ACTIVE', 300, 200, 6400, -30],
  ['TNK-06', 'MH14LM2345', 'Tata Signa 2823 · 10,000 L', 10000, 'MAINTENANCE', 250, 150, 0, 6],
];

/** [employeeCode, name, phone, employmentStatus, availability, licenceDays] */
const DRIVERS = [
  ['DRV-101', 'Rakesh Kumar', '+919812340001', 'ACTIVE', 'ONLINE', 400],
  ['DRV-102', 'Suresh Yadav', '+919812340002', 'ACTIVE', 'ONLINE', 300],
  ['DRV-103', 'Imran Shaikh', '+919812340003', 'ACTIVE', 'ON_TRIP', 500],
  ['DRV-104', 'Ganesh More', '+919812340004', 'ACTIVE', 'BREAK', 250],
  ['DRV-105', 'Prakash Jadhav', '+919812340005', 'ACTIVE', 'OFFLINE', 200],
  ['DRV-106', 'Vijay Sawant', '+919812340006', 'SUSPENDED', 'OFFLINE', 150],
];

/** [quantity, status, city] — the dispatch board's working set. */
const ORDERS = [
  [200, 'CONFIRMED', 'Pune'],
  [500, 'CONFIRMED', 'Pune'],
  [1000, 'ALLOCATING', 'Pune'],
  [300, 'ALLOCATING', 'Pimpri-Chinchwad'],
  [2500, 'ALLOCATION_FAILED', 'Pune'],
  [150, 'ALLOCATION_FAILED', 'Pune'],
  [400, 'ASSIGNED', 'Pune'],
  [750, 'EN_ROUTE', 'Pune'],
  [600, 'DELIVERED', 'Pune'],
  [220, 'CLOSED', 'Pune'],
];

async function main() {
  const admin = await prisma.user.findFirst({
    where: { principal: 'ADMIN' },
    select: { id: true },
  });
  if (!admin) throw new Error('No ADMIN user. Run `npm run create:admin` first.');

  const driverRole = await prisma.role.findUnique({ where: { code: 'DRIVER' } });
  if (!driverRole) throw new Error('Run `npm run prisma:seed` first.');

  // --- Product and price ---------------------------------------------------
  const product = await prisma.fuelProduct.upsert({
    where: { code: 'HSD' },
    create: { code: 'HSD', name: 'High-Speed Diesel', unit: 'LITRE', displayOrder: 1 },
    update: {},
    select: { id: true, code: true, name: true, unit: true },
  });

  let price = await prisma.fuelPrice.findFirst({
    where: { productId: product.id, city: 'Pune' },
    orderBy: { effectiveFrom: 'desc' },
  });

  if (!price) {
    price = await prisma.fuelPrice.create({
      data: {
        productId: product.id,
        city: 'Pune',
        pricePerUnit: '94.2000',
        effectiveFrom: day(-1),
        createdByUserId: admin.id,
      },
    });
  }

  const rate = Number(price.pricePerUnit);

  // --- Vehicles ------------------------------------------------------------
  const vehicles = [];
  for (const [num, reg, model, cap, status, calDays, pucDays, fuel, staleHours] of VEHICLES) {
    const vehicle = await prisma.vehicle.upsert({
      where: { vehicleNumber: num },
      create: {
        vehicleNumber: num,
        registrationNumber: reg,
        makeModel: model,
        tankCapacity: String(cap),
        compartmentCount: 2,
        status,
        pesoLicenseNumber: `PESO/${num}/2024`,
        pesoLicenseExpiry: day(500),
        calibrationCertNumber: `LM/${num}/2026`,
        calibrationExpiry: day(calDays),
        insuranceExpiry: day(300),
        pucExpiry: day(pucDays),
        fitnessExpiry: day(420),
        createdByUserId: admin.id,
      },
      update: { status, calibrationExpiry: day(calDays), pucExpiry: day(pucDays) },
      select: { id: true, vehicleNumber: true },
    });

    const staleAfter = new Date(Date.now() + staleHours * 3600_000);

    await prisma.vehicleInventory.upsert({
      where: { vehicleId: vehicle.id },
      create: {
        vehicleId: vehicle.id,
        currentQuantity: String(fuel),
        heldQuantity: '0',
        lastSource: 'DIP',
        lastVerifiedAt: new Date(),
        staleAfter,
      },
      update: { currentQuantity: String(fuel), staleAfter },
    });

    vehicles.push(vehicle);
  }

  // --- Drivers -------------------------------------------------------------
  const drivers = [];
  for (const [code, name, phone, employment, availability, licDays] of DRIVERS) {
    const user = await prisma.user.upsert({
      where: { phone_principal: { phone, principal: 'DRIVER' } },
      create: {
        principal: 'DRIVER',
        phone,
        status: 'ACTIVE',
        phoneVerifiedAt: new Date(),
        roles: { create: { roleId: driverRole.id } },
      },
      update: {},
      select: { id: true },
    });

    const driver = await prisma.driverProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        employeeCode: code,
        fullName: name,
        licenseNumber: `MH12-${code}`,
        licenseExpiry: day(licDays),
        joinedOn: day(-400),
        employmentStatus: employment,
        availability,
        createdByUserId: admin.id,
      },
      update: { employmentStatus: employment, availability, licenseExpiry: day(licDays) },
      select: { id: true, fullName: true },
    });

    drivers.push(driver);
  }

  // --- Assignments ---------------------------------------------------------
  // TNK-04 is left unassigned on purpose: it already carries a hard blocker,
  // and pairing it with a driver would hide that in the UI.
  const pairs = [
    [0, 0],
    [1, 1],
    [2, 2],
    [4, 3],
  ];

  for (const [vehicleIndex, driverIndex] of pairs) {
    const existing = await prisma.vehicleAssignment.findFirst({
      where: { vehicleId: vehicles[vehicleIndex].id, releasedAt: null },
    });

    if (!existing) {
      await prisma.vehicleAssignment.create({
        data: {
          vehicleId: vehicles[vehicleIndex].id,
          driverProfileId: drivers[driverIndex].id,
          assignedByUserId: admin.id,
        },
      });
    }
  }

  // --- Orders --------------------------------------------------------------
  const customers = await prisma.customerProfile.findMany({
    take: 6,
    select: { userId: true, fullName: true },
  });
  if (customers.length === 0) throw new Error('No customers. Run `npm run seed:demo` first.');

  let created = 0;

  for (const [index, [quantity, status, city]] of ORDERS.entries()) {
    const orderNumber = `DFY-2607-${String(900 + index).padStart(6, '0')}`;

    const already = await prisma.order.findUnique({ where: { orderNumber } });
    if (already) continue;

    const customer = customers[index % customers.length];
    const address = await prisma.address.findFirst({
      where: { userId: customer.userId, archivedAt: null },
    });
    if (!address) continue;

    /**
     * Mirrors `tax-engine.service.js` exactly.
     *
     * There are TWO lines, not three. `deliveryAmount` is the delivery line
     * TOTAL and already contains its GST; `taxAmount` is a memo reporting the
     * tax sitting inside both lines and is NOT added to the total again. The
     * database pins this: `total_amount = fuel_amount + delivery_amount`.
     *
     * Adding tax a third time is the classic way to overcharge by 18% of the
     * delivery fee on every order.
     */
    const fuelAmount = quantity * rate;
    const deliveryNet = 250;
    const deliveryTax = deliveryNet * 0.18;
    const deliveryAmount = deliveryNet + deliveryTax;
    const taxAmount = deliveryTax;
    const totalAmount = fuelAmount + deliveryAmount;

    const pricingSnapshot = {
      breakdownVersion: 1,
      lines: [
        {
          kind: 'FUEL',
          label: `${product.name} — ${quantity} L @ ₹${rate.toFixed(2)}/L`,
          hsnSac: '27101944',
          // Diesel sits OUTSIDE GST: central excise plus state VAT, already in
          // the rate (BR-701, BR-705).
          regime: 'NON_GST',
          taxInclusive: true,
          netAmount: money(fuelAmount),
          taxAmount: '0.00',
          lineTotal: money(fuelAmount),
          taxNote: 'Includes central excise and state VAT',
        },
        {
          kind: 'DELIVERY',
          label: 'Delivery charge',
          hsnSac: '996812',
          // The delivery charge IS inside GST, at 18%, and is tax-exclusive
          // before tax is applied (BR-702, BR-705).
          regime: 'GST',
          taxInclusive: false,
          netAmount: money(deliveryNet),
          taxRate: '18.00',
          taxAmount: money(deliveryTax),
          lineTotal: money(deliveryAmount),
        },
      ],
      totals: {
        fuelAmount: money(fuelAmount),
        deliveryAmount: money(deliveryAmount),
        taxAmount: money(taxAmount),
        grandTotal: money(totalAmount),
      },
      priceVersion: { priceId: price.id, pricePerUnit: rate.toFixed(4) },
      placeOfSupply: 'Maharashtra',
    };

    const quote = await prisma.quote.create({
      data: {
        userId: customer.userId,
        addressId: address.id,
        productId: product.id,
        priceId: price.id,
        quantity: String(quantity),
        fuelAmount: money(fuelAmount),
        deliveryAmount: money(deliveryAmount),
        taxAmount: money(taxAmount),
        totalAmount: money(totalAmount),
        city,
        state: 'Maharashtra',
        expiresAt: new Date(Date.now() + 15 * 60_000),
        breakdown: pricingSnapshot,
      },
      select: { id: true },
    });

    const placedAt = new Date(Date.now() - (index + 1) * 37 * 60_000);

    const order = await prisma.order.create({
      data: {
        orderNumber,
        userId: customer.userId,
        quoteId: quote.id,
        addressId: address.id,
        productId: product.id,
        priceId: price.id,
        quantity: String(quantity),
        fuelAmount: money(fuelAmount),
        deliveryAmount: money(deliveryAmount),
        taxAmount: money(taxAmount),
        totalAmount: money(totalAmount),
        status,
        paymentStatus: index % 3 === 0 ? 'NOT_REQUIRED' : 'CAPTURED',
        settlementStatus: 'NOT_REQUIRED',
        paymentMode: index % 3 === 0 ? 'CASH_ON_DELIVERY' : 'PREPAID_ONLINE',
        city,
        state: 'Maharashtra',
        deliveryInstructions: index % 2 === 0 ? 'Gate 2, security pass needed' : null,
        customerSnapshot: {
          userId: customer.userId,
          fullName: customer.fullName,
          phone: null,
        },
        addressSnapshot: {
          nickname: address.nickname,
          line1: address.line1,
          line2: address.line2,
          landmark: address.landmark,
          city: address.city,
          state: address.state,
          pincode: address.pincode,
          contactName: address.contactName,
          contactPhone: address.contactPhone,
          latitude: String(address.latitude),
          longitude: String(address.longitude),
        },
        productSnapshot: { code: product.code, name: product.name, unit: product.unit },
        pricingSnapshot,
        placedAt,
        statusChangedAt: placedAt,
        ...(status === 'DELIVERED' || status === 'CLOSED'
          ? { deliveredQuantity: String(quantity), finalTotalAmount: money(totalAmount) }
          : {}),
      },
      select: { id: true },
    });

    // A timeline, so the order detail has real history rather than one row.
    const path = ['CONFIRMED', 'ALLOCATING', 'ASSIGNED', 'EN_ROUTE', 'DELIVERED', 'CLOSED'];
    const target = path.indexOf(status);
    const chain = target === -1 ? ['CONFIRMED', status] : path.slice(0, target + 1);

    let previous = null;
    for (const [step, to] of chain.entries()) {
      // The database pins this: a human transition with no human attached is
      // not auditable, and a SYSTEM one WITH a user attached is a lie about
      // who acted. Both halves are enforced by a check constraint.
      const isCustomerAction = to === 'CONFIRMED';

      await prisma.orderStatusEvent.create({
        data: {
          orderId: order.id,
          fromStatus: previous,
          toStatus: to,
          actorKind: isCustomerAction ? 'CUSTOMER' : 'SYSTEM',
          actorUserId: isCustomerAction ? customer.userId : null,
          reason:
            to === 'ALLOCATION_FAILED'
              ? 'No vehicle met every constraint'
              : to === 'CONFIRMED'
                ? 'Order placed'
                : `Moved to ${to}`,
          occurredAt: new Date(placedAt.getTime() + step * 4 * 60_000),
        },
      });
      previous = to;
    }

    created += 1;
  }

  const [v, d, o] = await Promise.all([
    prisma.vehicle.count(),
    prisma.driverProfile.count(),
    prisma.order.count(),
  ]);

  console.log(`\nOperations data ready.\n  vehicles: ${v}\n  drivers:  ${d}\n  orders:   ${o} (${created} new)\n`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
