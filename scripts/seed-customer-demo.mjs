/**
 * Provision a demo CUSTOMER so the app opens on something worth showing.
 *
 * A brand-new signup lands on an empty home screen: no address, no history, and
 * therefore no two-tap reorder — which is the single thing the customer app is
 * designed around. This creates a customer who has been ordering for a fortnight.
 *
 * Orders are created through the REAL quote and order services, not written
 * straight into the table, so every row has a genuine price breakdown, a real
 * status timeline and a valid invoice. A hand-inserted order would look right
 * and reconcile wrong.
 *
 *   node scripts/seed-customer-demo.mjs
 *
 * Idempotent. Prints the phone number to sign in with.
 */
import { prisma } from '../src/infrastructure/database/prisma.js';
import * as addressService from '../src/modules/customer/services/address.service.js';
import * as customerService from '../src/modules/customer/services/customer.service.js';
import { createOrder } from '../src/modules/order/services/create-order.service.js';
import { transitionOrder } from '../src/modules/order/services/transition-order.service.js';
import * as quoteService from '../src/modules/pricing/services/quote.service.js';

const PHONE = '+919812345678';

/** Ordered oldest first, so the newest lands at the top of Home. */
const HISTORY = [
  { quantity: '500', status: 'CLOSED', delivered: '500.000' },
  // Ordered 1000, tank was full at 940. A short delivery is a NORMAL outcome,
  // and the demo should show one — the app is built to explain it.
  { quantity: '1000', status: 'CLOSED', delivered: '940.500' },
  { quantity: '200', status: 'CLOSED', delivered: '200.000' },
];

/** The path an order actually walks. No shortcuts through the state machine. */
const TO_DELIVERED = ['ALLOCATING', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'DISPENSING'];

async function main() {
  const admin = await prisma.user.findFirst({
    where: { principal: 'ADMIN' },
    select: { id: true },
  });
  if (!admin) throw new Error('No ADMIN user. Run `npm run create:admin` first.');

  const product = await prisma.fuelProduct.findUnique({
    where: { code: 'HSD' },
    select: { id: true },
  });
  if (!product) throw new Error('No HSD product. Run `npm run seed:operations` first.');

  const rule = await prisma.deliveryChargeRule.findFirst({
    where: { city: 'Pune', status: 'ACTIVE' },
    select: { id: true },
  });
  if (!rule) throw new Error('No delivery rule. Run `npm run seed:pricing` first.');

  // --- Identity --------------------------------------------------------------
  const customerRole = await prisma.role.findUnique({ where: { code: 'CUSTOMER' } });
  if (!customerRole) throw new Error('Run `npm run prisma:seed` first.');

  let user = await prisma.user.findFirst({
    where: { phone: PHONE, principal: 'CUSTOMER' },
    select: { id: true },
  });

  if (user) {
    console.log(`  customer ${PHONE} already exists`);
  } else {
    user = await prisma.user.create({
      data: {
        principal: 'CUSTOMER',
        phone: PHONE,
        phoneVerifiedAt: new Date(),
        status: 'ACTIVE',
        roles: { create: { roleId: customerRole.id } },
      },
      select: { id: true },
    });
    console.log(`  created customer identity ${PHONE}`);
  }

  const existingProfile = await prisma.customerProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  if (!existingProfile) {
    await customerService.registerCustomer({
      userId: user.id,
      fullName: 'Ramesh Kumar',
      preferredLanguage: 'en',
      marketingOptIn: false,
    });
    console.log('  created the customer profile');
  }

  // --- Addresses -------------------------------------------------------------
  const existingAddresses = await prisma.address.findMany({
    where: { userId: user.id, archivedAt: null },
    select: { id: true, nickname: true },
  });

  let siteAddress = existingAddresses.find((a) => a.nickname === 'Bhosari site');

  if (!siteAddress) {
    siteAddress = await addressService.createAddress({
      userId: user.id,
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
      contactName: 'Sunil Patil',
      contactPhone: '+919823456789',
      isDefault: true,
    });
    console.log('  created address: Bhosari site (default)');
  }

  if (!existingAddresses.some((a) => a.nickname === 'Chakan yard')) {
    await addressService.createAddress({
      userId: user.id,
      nickname: 'Chakan yard',
      line1: 'Survey 88, Chakan Industrial Area',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '410501',
      latitude: '18.760000',
      longitude: '73.860000',
      deliveryInstructions: 'Weekdays only. Call the yard supervisor on arrival.',
      isDefault: false,
    });
    console.log('  created address: Chakan yard');
  }

  // --- Order history ---------------------------------------------------------
  const alreadyPlaced = await prisma.order.count({ where: { userId: user.id } });

  if (alreadyPlaced > 0) {
    console.log(`  ${alreadyPlaced} order(s) already present — leaving history alone`);
  } else {
    for (const [index, entry] of HISTORY.entries()) {
      const quote = await quoteService.createQuote({
        userId: user.id,
        addressId: siteAddress.id,
        productId: product.id,
        quantity: entry.quantity,
      });

      const placed = await createOrder({
        userId: user.id,
        quoteId: quote.id,
        paymentMode: 'CASH_ON_DELIVERY',
        deliveryInstructions: 'Gate 2. Security pass needed.',
        acknowledgeDuplicate: true,
        requestId: `seed-customer-demo-${index}`,
      });

      const orderId = placed.body.data.order.id;

      for (const status of TO_DELIVERED) {
        await transitionOrder({
          orderId,
          toStatus: status,
          actorKind: 'ADMIN',
          actorUserId: admin.id,
          reason: 'Demo seed',
        });
      }

      await transitionOrder({
        orderId,
        toStatus: 'DELIVERED',
        actorKind: 'ADMIN',
        actorUserId: admin.id,
        reason: 'Demo seed',
      });

      // What the meter actually recorded. Ordered and delivered differ on a
      // real share of orders, and the app shows both.
      await prisma.order.update({
        where: { id: orderId },
        data: { deliveredQuantity: entry.delivered },
      });

      if (entry.status === 'CLOSED') {
        await transitionOrder({
          orderId,
          toStatus: 'CLOSED',
          actorKind: 'ADMIN',
          actorUserId: admin.id,
          reason: 'Demo seed',
        });
      }

      console.log(
        `  order ${index + 1}: ${entry.quantity} L ordered, ${entry.delivered} L delivered, ${entry.status}`
      );
    }
  }

  console.log('\nSign in with:');
  console.log(`  ${PHONE}   (enter 9812345678 — the app prefixes +91)`);
  console.log('  The OTP is shown on the login screen in development builds.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
