import '../helpers/env.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

/**
 * The order engine, end to end against a real database.
 *
 * SKIPPED unless TEST_DATABASE_URL is set. Requires the migration AND the seed.
 *
 * The cases that earn their keep here are the ones no unit test can prove:
 * that two simultaneous submissions produce one order, that two orders cannot
 * be promised the same litres, and that the snapshots survive an attempt to
 * change them.
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);

if (enabled) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

describe(
  'order engine (integration)',
  { skip: enabled ? false : 'TEST_DATABASE_URL not set' },
  () => {
    let server;
    let baseUrl;
    let prisma;

    let adminToken;
    let customerToken;
    let otherToken;
    let customerUserId;

    const stamp = String(Date.now()).slice(-8);
    const adminEmail = `order.admin.${stamp}@example.test`;
    const password = 'a-sufficiently-long-admin-password';
    const customerPhone = `+9188${stamp}`;
    const otherPhone = `+9187${stamp}`;
    const productCode = `HSD_O${stamp}`;
    const taxCodes = [`OVAT_${stamp}`, `OCGST_${stamp}`, `OSGST_${stamp}`];
    const city = `Ordertown${stamp}`;
    /**
     * A UNIQUE state, not a real one.
     *
     * Tax rules are scoped by state (BR-707), and `node --test` runs suite
     * files CONCURRENTLY against one database. Sharing "West Bengal" with the
     * pricing suite meant its quotes picked up this suite's delivery tax rules
     * as well as their own - 18% became 54%, and the failure looked like a tax
     * engine bug rather than test interference.
     */
    const state = `Ordershire${stamp}`;
    const vehicleNumbers = [`OTK1-${stamp}`, `OTK2-${stamp}`];

    let productId;
    let addressId;
    let otherAddressId;
    const vehicleIds = [];

    const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      return { status: response.status, body: await response.json() };
    };

    const signInCustomer = async (phone) => {
      const requested = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone, principal: 'CUSTOMER', purpose: 'SIGNUP' },
      });

      const verified = await call('/auth/otp/verify', {
        method: 'POST',
        body: {
          phone,
          principal: 'CUSTOMER',
          purpose: 'SIGNUP',
          code: requested.body.data.devCode,
        },
      });

      assert.equal(verified.status, 200, `sign-in failed for ${phone}`);

      return {
        token: verified.body.data.tokens.accessToken,
        userId: verified.body.data.user.id,
      };
    };

    /** A fresh quote. Orders are always created from one (BR-801). */
    const requestQuote = async ({ token = customerToken, address, quantity = '100' } = {}) => {
      const { status, body } = await call('/quotes', {
        method: 'POST',
        body: { addressId: address ?? addressId, productId, quantity },
        token,
      });

      assert.equal(status, 201, JSON.stringify(body));
      return body.data.quote;
    };

    const placeOrder = async ({
      token = customerToken,
      quoteId,
      paymentMode = 'CASH_ON_DELIVERY',
      key = randomUUID(),
      ...rest
    }) =>
      call('/orders', {
        method: 'POST',
        body: { quoteId, paymentMode, acknowledgeDuplicate: true, ...rest },
        token,
        headers: { 'idempotency-key': key },
      });

    /** Place a quote and an order in one step, for tests that need an order. */
    const newOrder = async (overrides = {}) => {
      const quote = await requestQuote(overrides);
      const { status, body } = await placeOrder({ quoteId: quote.id, ...overrides });

      assert.equal(status, 201, JSON.stringify(body));
      return body.data.order;
    };

    before(async () => {
      const { createApp } = await import('../../src/app.js');
      ({ prisma } = await import('../../src/infrastructure/database/prisma.js'));
      await prisma.$connect();

      server = createApp().listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

      // --- Admin ------------------------------------------------------------
      const { hashPassword } =
        await import('../../src/modules/identity/services/password.service.js');
      const role = await prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' } });
      assert.ok(role, 'seed must have run');

      await prisma.user.create({
        data: {
          principal: 'ADMIN',
          email: adminEmail,
          passwordHash: await hashPassword(password),
          emailVerifiedAt: new Date(),
          roles: { create: { roleId: role.id } },
        },
      });

      const login = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'ADMIN', email: adminEmail, password },
      });
      assert.equal(login.status, 200);
      adminToken = login.body.data.tokens.accessToken;

      // --- Customers --------------------------------------------------------
      ({ token: customerToken, userId: customerUserId } = await signInCustomer(customerPhone));
      ({ token: otherToken } = await signInCustomer(otherPhone));

      const makeAddress = async (token) => {
        const { status, body } = await call('/customers/addresses', {
          method: 'POST',
          body: {
            nickname: 'Genset yard',
            line1: '9 Order Road',
            city,
            state,
            pincode: '700156',
            latitude: '22.5726',
            longitude: '88.3639',
          },
          token,
        });

        assert.equal(status, 201, JSON.stringify(body));
        return body.data.address.id;
      };

      addressId = await makeAddress(customerToken);
      otherAddressId = await makeAddress(otherToken);

      // --- Catalogue --------------------------------------------------------
      const product = await call('/admin/products', {
        method: 'POST',
        body: { code: productCode, name: 'High-Speed Diesel', hsnCode: '27101944' },
        token: adminToken,
      });
      assert.equal(product.status, 201, JSON.stringify(product.body));
      productId = product.body.data.product.id;

      const taxes = [
        {
          name: 'VAT',
          code: taxCodes[0],
          regime: 'VAT_EXCISE',
          appliesTo: 'FUEL',
          isInclusive: true,
          rate: '24',
          state,
          sequence: 10,
        },
        {
          name: 'CGST',
          code: taxCodes[1],
          regime: 'GST',
          appliesTo: 'DELIVERY',
          isInclusive: false,
          rate: '9',
          state,
          sacCode: '996511',
          sequence: 10,
        },
        {
          name: 'SGST',
          code: taxCodes[2],
          regime: 'GST',
          appliesTo: 'DELIVERY',
          isInclusive: false,
          rate: '9',
          state,
          sacCode: '996511',
          sequence: 20,
        },
      ];

      for (const rule of taxes) {
        const created = await call('/admin/taxes', {
          method: 'POST',
          body: { ...rule, effectiveFrom: '2026-01-01T00:00:00.000Z' },
          token: adminToken,
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
      }

      const charge = await call('/admin/delivery-charges', {
        method: 'POST',
        body: {
          name: 'Standard',
          city,
          flatCharge: '250.00',
          minQuantity: '0',
          sacCode: '996511',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
        token: adminToken,
      });
      assert.equal(charge.status, 201, JSON.stringify(charge.body));

      const price = await call('/admin/prices', {
        method: 'POST',
        body: { productId, city, pricePerUnit: '94.7700' },
        token: adminToken,
      });
      assert.equal(price.status, 201, JSON.stringify(price.body));

      // --- Fleet: two tankers, deliberately small ---------------------------
      // 300 litres is the docs/08 §9.1 scenario verbatim: two 200-litre orders
      // must not both succeed against it.
      for (const [index, vehicleNumber] of vehicleNumbers.entries()) {
        const vehicle = await call('/admin/vehicles', {
          method: 'POST',
          body: {
            vehicleNumber,
            // The index matters: both numbers end in the same shared stamp, so
            // deriving the registration from the tail alone collides.
            registrationNumber: `WB9${index}${stamp.slice(-6)}`,
            tankCapacity: '12000.000',
          },
          token: adminToken,
        });

        assert.equal(vehicle.status, 201, JSON.stringify(vehicle.body));
        vehicleIds.push(vehicle.body.data.vehicle.id);
      }

      /**
       * Tanker 0 carries plenty, so ordinary cases are not competing for fuel.
       * Tanker 1 is left EMPTY and is stocked only by the concurrency case,
       * which needs a tanker that exactly one of two orders can fit into.
       */
      const refill = await call(`/admin/vehicles/${vehicleIds[0]}/refill`, {
        method: 'POST',
        body: { quantity: '5000.000', depotName: 'Test depot', invoiceRef: 'INV-1' },
        token: adminToken,
      });
      assert.equal(refill.status, 201, JSON.stringify(refill.body));
    });

    after(async () => {
      if (prisma) {
        await prisma.outboxEvent.deleteMany({ where: { aggregate: 'order' } });
        await prisma.idempotencyKey.deleteMany({ where: { userId: customerUserId } });

        /**
         * The append-only trigger blocks the cascade from `orders`, which is
         * CORRECT: docs/08 §5 says orders and their history are never deleted,
         * and the trigger is what makes that true against a support script as
         * well as against application code.
         *
         * A test fixture is the one legitimate exception, so it suspends the
         * trigger explicitly rather than the trigger being weakened to
         * accommodate it. Being noisy about it here is the point - if this line
         * ever appears in application code, something is wrong.
         */
        await prisma.$executeRawUnsafe(
          'ALTER TABLE order_status_events DISABLE TRIGGER order_status_events_no_delete'
        );

        // orders cascade to status events and reservations.
        await prisma.order.deleteMany({ where: { city } });

        await prisma.$executeRawUnsafe(
          'ALTER TABLE order_status_events ENABLE TRIGGER order_status_events_no_delete'
        );
        await prisma.quote.deleteMany({ where: { city } });
        await prisma.fuelPrice.deleteMany({ where: { city } });
        await prisma.fuelProduct.deleteMany({ where: { code: productCode } });
        await prisma.taxRule.deleteMany({ where: { code: { in: taxCodes } } });
        await prisma.deliveryChargeRule.deleteMany({ where: { city } });
        await prisma.vehicle.deleteMany({ where: { vehicleNumber: { in: vehicleNumbers } } });
        await prisma.otpChallenge.deleteMany({
          where: { identifier: { in: [customerPhone, otherPhone] } },
        });
        await prisma.user.deleteMany({
          where: { OR: [{ phone: { in: [customerPhone, otherPhone] } }, { email: adminEmail }] },
        });
        await prisma.$disconnect();
      }
      server?.close();
    });

    // --- Quote to order conversion -----------------------------------------

    it('converts a quote into an order', async () => {
      const quote = await requestQuote({ quantity: '50' });
      const { status, body } = await placeOrder({ quoteId: quote.id });

      assert.equal(status, 201, JSON.stringify(body));

      const order = body.data.order;

      assert.match(order.orderNumber, /^DFY-\d{4}-\d{6}$/);
      // COD is confirmed immediately (docs/04 §2).
      assert.equal(order.status, 'CONFIRMED');
      assert.equal(order.paymentStatus, 'NOT_REQUIRED');
      assert.equal(order.settlementStatus, 'NOT_REQUIRED');

      // The amounts are the QUOTE's, copied - not recomputed.
      assert.equal(order.totalAmount, quote.totalAmount);
      assert.equal(order.fuelAmount, quote.fuelAmount);

      for (const field of ['quantity', 'fuelAmount', 'totalAmount']) {
        assert.equal(typeof order[field], 'string', field);
      }
    });

    it('locks the order to the exact price version the quote used (BR-606)', async () => {
      const quote = await requestQuote({ quantity: '20' });
      const { body } = await placeOrder({ quoteId: quote.id });

      const stored = await prisma.order.findUnique({
        where: { id: body.data.order.id },
        select: { priceId: true, quoteId: true },
      });

      const quoteRow = await prisma.quote.findUnique({
        where: { id: quote.id },
        select: { priceId: true, status: true },
      });

      assert.equal(stored.priceId, quoteRow.priceId);
      // BR-802: the quote is spent.
      assert.equal(quoteRow.status, 'CONSUMED');
    });

    it('refuses to convert the same quote twice (BR-802)', async () => {
      const quote = await requestQuote({ quantity: '20' });

      const first = await placeOrder({ quoteId: quote.id });
      assert.equal(first.status, 201);

      const second = await placeOrder({ quoteId: quote.id });

      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, 'QUOTE_ALREADY_USED');
    });

    it('refuses an expired quote with 410, not 409 (BR-605)', async () => {
      const quote = await requestQuote({ quantity: '20' });

      await prisma.quote.update({
        where: { id: quote.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const { status, body } = await placeOrder({ quoteId: quote.id });

      // 410 Gone: the quote has not conflicted with anything, it has ceased to
      // be usable. The client's next step is to re-quote and show the price
      // comparison, which is a different screen from any 409.
      assert.equal(status, 410);
      assert.equal(body.error.code, 'QUOTE_EXPIRED');
    });

    it("refuses another customer's quote with a 404, not a 403", async () => {
      const quote = await requestQuote({ token: otherToken, address: otherAddressId });

      const { status } = await placeOrder({ quoteId: quote.id, token: customerToken });

      assert.equal(status, 404);
    });

    it('refuses a payment mode whose module does not exist yet', async () => {
      const quote = await requestQuote({ quantity: '20' });

      const { status, body } = await placeOrder({
        quoteId: quote.id,
        paymentMode: 'CORPORATE_CREDIT',
      });

      // Refused rather than silently skipping the credit hold, which would let
      // a customer order past their limit (BR-235).
      assert.equal(status, 400);
      assert.equal(body.error.code, 'PAYMENT_MODE_UNSUPPORTED');
    });

    it('parks a prepaid order in PENDING_PAYMENT with an expiry (BR-1006)', async () => {
      const quote = await requestQuote({ quantity: '20' });
      const { body } = await placeOrder({ quoteId: quote.id, paymentMode: 'PREPAID_ONLINE' });

      assert.equal(body.data.order.status, 'PENDING_PAYMENT');
      assert.equal(body.data.order.paymentStatus, 'PENDING');
      assert.notEqual(body.data.order.expiresAt, null);
    });

    // --- Snapshots ----------------------------------------------------------

    it('freezes the customer, address, product and pricing onto the order', async () => {
      const order = await newOrder({ quantity: '20' });

      const stored = await prisma.order.findUnique({
        where: { id: order.id },
        select: {
          customerSnapshot: true,
          addressSnapshot: true,
          productSnapshot: true,
          pricingSnapshot: true,
        },
      });

      assert.equal(stored.addressSnapshot.line1, '9 Order Road');
      assert.equal(stored.addressSnapshot.city, city);
      assert.equal(stored.productSnapshot.code, productCode.toUpperCase());
      assert.equal(stored.productSnapshot.hsnCode, '27101944');
      assert.equal(stored.customerSnapshot.phone, customerPhone);
      assert.ok(Array.isArray(stored.pricingSnapshot.lines));
    });

    /** BR-805, the headline promise of the snapshot design. */
    it('does not change an in-flight order when the saved address is edited', async () => {
      const order = await newOrder({ quantity: '20' });

      const before = await prisma.order.findUnique({
        where: { id: order.id },
        select: { addressSnapshot: true },
      });

      const edit = await call(`/customers/addresses/${addressId}`, {
        method: 'PATCH',
        body: { line1: 'A COMPLETELY DIFFERENT PLACE' },
        token: customerToken,
      });
      assert.equal(edit.status, 200);

      const afterEdit = await prisma.order.findUnique({
        where: { id: order.id },
        select: { addressSnapshot: true },
      });

      assert.deepEqual(afterEdit.addressSnapshot, before.addressSnapshot);
      assert.equal(afterEdit.addressSnapshot.line1, '9 Order Road');

      // Put it back so later cases quote against the original address.
      await call(`/customers/addresses/${addressId}`, {
        method: 'PATCH',
        body: { line1: '9 Order Road' },
        token: customerToken,
      });
    });

    /**
     * "Financial snapshots are immutable", enforced by the database.
     *
     * Bypasses the service entirely, because the service is not what the rule
     * is protecting against - a support script or a careless migration is.
     */
    it('makes the frozen amounts physically unchangeable', async () => {
      const order = await newOrder({ quantity: '20' });

      await assert.rejects(
        prisma.order.update({
          where: { id: order.id },
          data: { totalAmount: '1.00' },
        }),
        /immutable financial snapshots/i
      );

      await assert.rejects(
        prisma.order.update({
          where: { id: order.id },
          data: { addressSnapshot: { line1: 'somewhere else' } },
        }),
        /immutable financial snapshots/i
      );
    });

    it('still allows the reconciliation columns to be written', async () => {
      // delivered_quantity and final_total_amount are deliberately NOT frozen -
      // they are what reconciliation writes (ADR-009).
      const order = await newOrder({ quantity: '20' });

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: { deliveredQuantity: '18.500', finalTotalAmount: '2000.00' },
        select: { deliveredQuantity: true },
      });

      assert.equal(String(updated.deliveredQuantity), '18.5');
    });

    // --- Idempotency (BR-803) ----------------------------------------------

    it('returns the original order when the same key is replayed', async () => {
      const quote = await requestQuote({ quantity: '20' });
      const key = randomUUID();

      const first = await placeOrder({ quoteId: quote.id, key });
      const second = await placeOrder({ quoteId: quote.id, key });

      assert.equal(first.status, 201);
      // The ORIGINAL status is replayed, not a 200. A client that branched on
      // 201 must behave identically on the retry it was told to make.
      assert.equal(second.status, 201);
      assert.equal(second.body.data.order.id, first.body.data.order.id);

      const count = await prisma.order.count({ where: { quoteId: quote.id } });
      assert.equal(count, 1, 'a replay created a second order');
    });

    it('rejects the same key used for a different request', async () => {
      const quoteA = await requestQuote({ quantity: '20' });
      const quoteB = await requestQuote({ quantity: '30' });
      const key = randomUUID();

      await placeOrder({ quoteId: quoteA.id, key });
      const reused = await placeOrder({ quoteId: quoteB.id, key });

      assert.equal(reused.status, 409);
      assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    });

    it('requires an idempotency key at all', async () => {
      const quote = await requestQuote({ quantity: '20' });

      const { status, body } = await call('/orders', {
        method: 'POST',
        body: { quoteId: quote.id, paymentMode: 'CASH_ON_DELIVERY' },
        token: customerToken,
      });

      assert.equal(status, 400);
      assert.equal(body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
    });

    /**
     * THE CONCURRENCY TEST docs/11 §9 demands: "Fire parallel requests ...
     * Assert exactly one winner."
     */
    it('creates ONE order when the same request is fired twice at once', async () => {
      const quote = await requestQuote({ quantity: '20' });
      const key = randomUUID();

      const [a, b] = await Promise.all([
        placeOrder({ quoteId: quote.id, key }),
        placeOrder({ quoteId: quote.id, key }),
      ]);

      const created = await prisma.order.count({ where: { quoteId: quote.id } });
      assert.equal(created, 1, 'a double-tap created two orders');

      // One wins with a 201. The other either replays it, or is told the first
      // attempt is still running - both are correct answers (docs/10 §8.2).
      const statuses = [a.status, b.status].sort();
      assert.ok(
        statuses[0] === 201 && (statuses[1] === 201 || statuses[1] === 409),
        `unexpected statuses: ${statuses}`
      );
    });

    it('creates ONE order when two DIFFERENT keys race the same quote', async () => {
      // Idempotency cannot help here - the keys differ. The unique constraint
      // on orders.quote_id is what stops it (BR-802).
      const quote = await requestQuote({ quantity: '20' });

      const results = await Promise.all([
        placeOrder({ quoteId: quote.id, key: randomUUID() }),
        placeOrder({ quoteId: quote.id, key: randomUUID() }),
      ]);

      const created = await prisma.order.count({ where: { quoteId: quote.id } });
      assert.equal(created, 1, 'one quote produced two orders');

      assert.equal(results.filter((r) => r.status === 201).length, 1);
    });

    // --- Reservations (BR-406) ---------------------------------------------

    it('reserves fuel against a vehicle on placement', async () => {
      const order = await newOrder({ quantity: '20' });

      const reservation = await prisma.fuelReservation.findFirst({
        where: { orderId: order.id, status: 'HELD' },
      });

      assert.ok(reservation, 'no reservation was held');
      assert.equal(String(reservation.quantity), '20');
      assert.equal(reservation.vehicleId, vehicleIds[0]);
    });

    it('adds the held litres to the vehicle without deducting stock', async () => {
      const before = await prisma.vehicleInventory.findUnique({
        where: { vehicleId: vehicleIds[0] },
      });

      await newOrder({ quantity: '10' });

      const afterOrder = await prisma.vehicleInventory.findUnique({
        where: { vehicleId: vehicleIds[0] },
      });

      // Held rises by 10; physical stock is untouched. Reserving is a promise,
      // and litres only move when fuel does (BR-408).
      assert.equal(
        Number(afterOrder.heldQuantity) - Number(before.heldQuantity),
        10,
        'held did not rise by the reserved amount'
      );
      assert.equal(
        String(afterOrder.currentQuantity),
        String(before.currentQuantity),
        'stock was deducted at reservation time'
      );
    });

    it('never lets held exceed what is physically in the tank (INV-03)', async () => {
      const inventory = await prisma.vehicleInventory.findUnique({
        where: { vehicleId: vehicleIds[0] },
      });

      assert.ok(
        Number(inventory.heldQuantity) <= Number(inventory.currentQuantity),
        `held ${inventory.heldQuantity} exceeds stock ${inventory.currentQuantity}`
      );
    });

    it('keeps held equal to the sum of live reservations (INV-03)', async () => {
      const inventory = await prisma.vehicleInventory.findUnique({
        where: { vehicleId: vehicleIds[0] },
      });

      const sum = await prisma.fuelReservation.aggregate({
        where: { vehicleId: vehicleIds[0], status: 'HELD' },
        _sum: { quantity: true },
      });

      assert.equal(
        Number(inventory.heldQuantity),
        Number(sum._sum.quantity ?? 0),
        'the cached held figure has drifted from the reservations'
      );
    });

    it('refuses an order it cannot reserve fuel for', async () => {
      // Far more than the whole fleet carries.
      const quote = await requestQuote({ quantity: '50000' });
      const { status, body } = await placeOrder({ quoteId: quote.id });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'NO_VEHICLE_AVAILABLE');

      // And the order it briefly created was cancelled rather than left
      // stranded without fuel.
      const order = await prisma.order.findUnique({ where: { quoteId: quote.id } });
      assert.equal(order.status, 'CANCELLED_BY_ADMIN');
    });

    /**
     * THE RACE FROM docs/08 §9.1, VERBATIM.
     *
     * "Two 200-litre orders arrive simultaneously for a tanker holding 300
     * litres. Both read the available quantity, both see 300, both succeed. One
     * customer receives an apologetic phone call."
     *
     * Exactly one must win.
     */
    it('promises the last litres to exactly one of two simultaneous orders', async () => {
      /**
       * The fixture has to leave EXACTLY ONE tanker able to take a 200 L order,
       * because the reservation service deliberately falls through to the next
       * candidate when one loses the race. With a second capable tanker in the
       * pool both orders would succeed - correctly - and prove nothing.
       *
       * So tanker 0 goes to MAINTENANCE (a real domain state that excludes it
       * from candidacy), and tanker 1 is stocked with exactly 300 L.
       */
      await prisma.vehicle.update({
        where: { id: vehicleIds[0] },
        data: { status: 'MAINTENANCE' },
      });

      const refill = await call(`/admin/vehicles/${vehicleIds[1]}/refill`, {
        method: 'POST',
        body: { quantity: '300.000', depotName: 'Test depot', invoiceRef: 'INV-RACE' },
        token: adminToken,
      });
      assert.equal(refill.status, 201, JSON.stringify(refill.body));

      const stock = await prisma.vehicleInventory.findUnique({
        where: { vehicleId: vehicleIds[1] },
      });
      assert.equal(String(stock.currentQuantity), '300', 'test precondition');
      assert.equal(Number(stock.heldQuantity), 0, 'test precondition');

      try {
        const [quoteA, quoteB] = await Promise.all([
          requestQuote({ quantity: '200' }),
          requestQuote({ quantity: '200' }),
        ]);

        const results = await Promise.all([
          placeOrder({ quoteId: quoteA.id, key: randomUUID() }),
          placeOrder({ quoteId: quoteB.id, key: randomUUID() }),
        ]);

        const winners = results.filter((r) => r.status === 201);
        const losers = results.filter((r) => r.status === 409);

        assert.equal(winners.length, 1, 'both 200 L orders were promised the same 300 L');
        assert.equal(losers.length, 1);
        assert.equal(losers[0].body.error.code, 'NO_VEHICLE_AVAILABLE');

        const held = await prisma.vehicleInventory.findUnique({
          where: { vehicleId: vehicleIds[1] },
        });
        assert.equal(Number(held.heldQuantity), 200, 'held is not exactly one order');
      } finally {
        // Restore, or every later case runs against a fleet in maintenance.
        await prisma.vehicle.update({
          where: { id: vehicleIds[0] },
          data: { status: 'ACTIVE' },
        });
      }
    });

    // --- Cancellation -------------------------------------------------------

    it('cancels an order and gives the fuel back (BR-1203)', async () => {
      const order = await newOrder({ quantity: '15' });

      // Read the vehicle the service actually chose rather than assuming one.
      // Allocation is best-fit across the fleet, so which tanker wins depends
      // on what earlier cases left held.
      const held = await prisma.fuelReservation.findFirstOrThrow({
        where: { orderId: order.id, status: 'HELD' },
      });

      const before = await prisma.vehicleInventory.findUnique({
        where: { vehicleId: held.vehicleId },
      });

      const { status, body } = await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Changed my mind' },
        token: customerToken,
      });

      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.data.order.status, 'CANCELLED_BY_CUSTOMER');
      assert.equal(body.data.order.cancellation.reason, 'Changed my mind');

      const afterCancel = await prisma.vehicleInventory.findUnique({
        where: { vehicleId: held.vehicleId },
      });

      assert.equal(
        Number(before.heldQuantity) - Number(afterCancel.heldQuantity),
        15,
        'cancelling did not release the reservation'
      );

      const reservation = await prisma.fuelReservation.findFirst({
        where: { orderId: order.id },
      });
      assert.equal(reservation.status, 'RELEASED');
      assert.equal(reservation.releaseReason, 'ORDER_CANCELLED');
    });

    it('requires a reason to cancel', async () => {
      const order = await newOrder({ quantity: '10' });

      const { status } = await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: {},
        token: customerToken,
      });

      assert.equal(status, 400);
    });

    it('refuses to cancel an already-cancelled order', async () => {
      const order = await newOrder({ quantity: '10' });

      await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'First cancellation' },
        token: customerToken,
      });

      const { status, body } = await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Second cancellation' },
        token: customerToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'ORDER_NOT_CANCELLABLE');
    });

    it('blocks in-app cancellation once the tanker is moving (BR-1202)', async () => {
      const order = await newOrder({ quantity: '10' });

      for (const toStatus of ['ALLOCATING', 'ASSIGNED', 'EN_ROUTE']) {
        const moved = await call(`/admin/orders/${order.id}/transition`, {
          method: 'POST',
          body: { toStatus, reason: 'Test progression' },
          token: adminToken,
        });
        assert.equal(moved.status, 200, `${toStatus}: ${JSON.stringify(moved.body)}`);
      }

      const { status, body } = await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Too late' },
        token: customerToken,
      });

      assert.equal(status, 409);
      // A REQUEST, not a refusal - the app shows a different screen for each.
      assert.equal(body.error.code, 'CANCELLATION_REQUIRES_OPERATOR');

      // An operator still can.
      const byAdmin = await call(`/admin/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Customer called; vehicle broke down' },
        token: adminToken,
      });

      assert.equal(byAdmin.status, 200);
      assert.equal(byAdmin.body.data.order.status, 'CANCELLED_BY_ADMIN');
    });

    // --- Timeline (docs/04 §26) ---------------------------------------------

    it('records every transition in the timeline, with an actor', async () => {
      const order = await newOrder({ quantity: '10' });

      await call(`/admin/orders/${order.id}/transition`, {
        method: 'POST',
        body: { toStatus: 'ALLOCATING', reason: 'Dispatch enqueued' },
        token: adminToken,
      });

      const { status, body } = await call(`/orders/${order.id}/history`, {
        token: customerToken,
      });

      assert.equal(status, 200);

      const timeline = body.data.timeline;
      assert.equal(timeline.length, 2);

      // The opening entry has no previous state - an order coming into
      // existence has none, and a sentinel would be a lie.
      assert.equal(timeline[0].previousStatus, null);
      assert.equal(timeline[0].status, 'CONFIRMED');
      assert.equal(timeline[0].actor, 'CUSTOMER');

      assert.equal(timeline[1].previousStatus, 'CONFIRMED');
      assert.equal(timeline[1].status, 'ALLOCATING');
      assert.equal(timeline[1].actor, 'ADMIN');
      assert.equal(timeline[1].reason, 'Dispatch enqueued');
    });

    it('keeps internal metadata out of the customer timeline', async () => {
      const order = await newOrder({ quantity: '10' });

      await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Not needed' },
        token: customerToken,
      });

      const { body } = await call(`/orders/${order.id}/history`, { token: customerToken });
      const serialised = JSON.stringify(body.data.timeline);

      // The released reservation id lives in metadata, which support sees and
      // the customer does not.
      assert.ok(!serialised.includes('releasedReservationId'));
      assert.ok(!serialised.includes('metadata'));

      const admin = await call(`/admin/orders/${order.id}/history`, { token: adminToken });
      const adminSerialised = JSON.stringify(admin.body.data.timeline);
      assert.ok(adminSerialised.includes('releasedReservationId'));
    });

    it('makes the timeline append-only at the database level', async () => {
      const order = await newOrder({ quantity: '10' });

      const event = await prisma.orderStatusEvent.findFirst({ where: { orderId: order.id } });

      await assert.rejects(
        prisma.orderStatusEvent.update({
          where: { id: event.id },
          data: { reason: 'rewriting history' },
        }),
        /append-only/i
      );

      await assert.rejects(
        prisma.orderStatusEvent.delete({ where: { id: event.id } }),
        /append-only/i
      );
    });

    // --- State transitions --------------------------------------------------

    it('refuses an illegal transition with 409', async () => {
      const order = await newOrder({ quantity: '10' });

      const { status, body } = await call(`/admin/orders/${order.id}/transition`, {
        method: 'POST',
        body: { toStatus: 'DELIVERED', reason: 'Skipping ahead' },
        token: adminToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'INVALID_STATE_TRANSITION');
    });

    it('refuses a transition the admin actor may not drive, with 403', async () => {
      const order = await newOrder({ quantity: '10' });

      // ALLOCATING -> ALLOCATION_FAILED is SYSTEM-only: it is the allocator
      // reporting that it exhausted its candidates, not a decision.
      await call(`/admin/orders/${order.id}/transition`, {
        method: 'POST',
        body: { toStatus: 'ALLOCATING', reason: 'Enqueued' },
        token: adminToken,
      });

      const { status, body } = await call(`/admin/orders/${order.id}/transition`, {
        method: 'POST',
        body: { toStatus: 'ALLOCATION_FAILED', reason: 'By hand' },
        token: adminToken,
      });

      assert.equal(status, 403);
      assert.equal(body.error.code, 'TRANSITION_NOT_PERMITTED');
    });

    it('refuses any transition out of a terminal state', async () => {
      const order = await newOrder({ quantity: '10' });

      await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Done with it' },
        token: customerToken,
      });

      const { status, body } = await call(`/admin/orders/${order.id}/transition`, {
        method: 'POST',
        body: { toStatus: 'ALLOCATING', reason: 'Un-cancel it' },
        token: adminToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'ORDER_ALREADY_TERMINAL');
    });

    it('will not route a cancellation through the generic transition endpoint', async () => {
      const order = await newOrder({ quantity: '10' });

      const { status } = await call(`/admin/orders/${order.id}/transition`, {
        method: 'POST',
        body: { toStatus: 'CANCELLED_BY_ADMIN', reason: 'Sneaking past order.cancel' },
        token: adminToken,
      });

      // Rejected by the schema: cancellation has its own endpoint, which
      // requires a different permission and records the canceller.
      assert.equal(status, 400);
    });

    it('honours expectedStatus against a stale dispatch board', async () => {
      const order = await newOrder({ quantity: '10' });

      const { status, body } = await call(`/admin/orders/${order.id}/transition`, {
        method: 'POST',
        body: {
          toStatus: 'ALLOCATING',
          reason: 'Acting on stale data',
          expectedStatus: 'ASSIGNED',
        },
        token: adminToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'INVALID_STATE_TRANSITION');
    });

    // --- Outbox (ADR-012) ---------------------------------------------------

    it('writes outbox events for a placed order', async () => {
      const order = await newOrder({ quantity: '10' });

      const events = await prisma.outboxEvent.findMany({
        where: { aggregate: 'order', aggregateId: order.id },
        orderBy: { createdAt: 'asc' },
      });

      const types = events.map((event) => event.eventType);

      assert.ok(types.includes('order.created'));
      assert.ok(types.includes('order.confirmed'));
      // Ordering ASKS for a vehicle; it never allocates one itself.
      assert.ok(types.includes('allocation.requested'));
    });

    it('makes the payload self-contained, so a consumer never reads our tables', async () => {
      const order = await newOrder({ quantity: '10' });

      const event = await prisma.outboxEvent.findFirst({
        where: { aggregateId: order.id, eventType: 'order.created' },
      });

      // Enough for Notifications to render a message on its own.
      assert.equal(event.payload.orderNumber, order.orderNumber);
      assert.equal(event.payload.totalAmount, order.totalAmount);
      assert.equal(event.payload.city, city);
      assert.equal(typeof event.payload.totalAmount, 'string');
    });

    it('writes a cancellation event', async () => {
      const order = await newOrder({ quantity: '10' });

      await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'No longer needed' },
        token: customerToken,
      });

      const events = await prisma.outboxEvent.findMany({
        where: { aggregateId: order.id, eventType: 'order.cancelled' },
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].payload.reason, 'No longer needed');
    });

    // --- Authorisation ------------------------------------------------------

    it("hides another customer's order behind a 404", async () => {
      const order = await newOrder({ quantity: '10' });

      const { status } = await call(`/orders/${order.id}`, { token: otherToken });

      assert.equal(status, 404);
    });

    it("hides another customer's timeline too", async () => {
      const order = await newOrder({ quantity: '10' });

      const { status } = await call(`/orders/${order.id}/history`, { token: otherToken });

      assert.equal(status, 404);
    });

    it("refuses to cancel another customer's order", async () => {
      const order = await newOrder({ quantity: '10' });

      const { status } = await call(`/orders/${order.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Not mine to cancel' },
        token: otherToken,
      });

      assert.equal(status, 404);
    });

    it('lists only the calling customer own orders', async () => {
      const { status, body } = await call('/orders', { token: otherToken });

      assert.equal(status, 200);

      for (const order of body.data.orders) {
        const stored = await prisma.order.findUnique({
          where: { id: order.id },
          select: { userId: true },
        });

        assert.notEqual(stored.userId, customerUserId);
      }
    });

    it('keeps customers out of every admin order endpoint', async () => {
      const order = await newOrder({ quantity: '10' });

      const endpoints = [
        ['GET', '/admin/orders'],
        ['GET', `/admin/orders/${order.id}`],
        ['POST', `/admin/orders/${order.id}/transition`],
        ['POST', `/admin/orders/${order.id}/reserve`],
        ['POST', `/admin/orders/${order.id}/release`],
      ];

      for (const [method, path] of endpoints) {
        const { status } = await call(path, {
          method,
          body: method === 'POST' ? { toStatus: 'ALLOCATING', reason: 'nope' } : undefined,
          token: customerToken,
        });

        assert.equal(status, 403, `${method} ${path}`);
      }
    });

    it('keeps admins out of the customer order surface', async () => {
      const { status } = await call('/orders', { token: adminToken });

      assert.equal(status, 403);
    });

    it('rejects an unauthenticated order request', async () => {
      const { status } = await call('/orders', { method: 'GET' });

      assert.equal(status, 401);
    });

    // --- Admin views --------------------------------------------------------

    it('gives an operator the order, timeline, reservations and next steps', async () => {
      const order = await newOrder({ quantity: '10' });

      const { status, body } = await call(`/admin/orders/${order.id}`, { token: adminToken });

      assert.equal(status, 200);
      assert.equal(body.data.order.id, order.id);
      assert.ok(body.data.timeline.length >= 1);
      assert.ok(body.data.reservations.length >= 1);
      // Rendered as buttons, straight from the transition table.
      assert.ok(body.data.allowedTransitions.some((entry) => entry.to === 'ALLOCATING'));
      // Internal references support needs.
      assert.ok(body.data.order.priceId);
      assert.ok(body.data.order.pricingSnapshot);
    });

    it('paginates the admin order list with a cursor', async () => {
      const { status, body } = await call('/admin/orders?limit=2', { token: adminToken });

      assert.equal(status, 200);
      assert.ok(body.data.orders.length <= 2);
      assert.equal(typeof body.data.pagination.hasMore, 'boolean');

      if (body.data.pagination.hasMore) {
        const next = await call(`/admin/orders?limit=2&cursor=${body.data.pagination.nextCursor}`, {
          token: adminToken,
        });

        assert.equal(next.status, 200);
        assert.notEqual(next.body.data.orders[0]?.id, body.data.orders[0].id);
      }
    });

    it('filters the admin list by status', async () => {
      const { body } = await call('/admin/orders?status=CANCELLED_BY_CUSTOMER', {
        token: adminToken,
      });

      for (const order of body.data.orders) {
        assert.equal(order.status, 'CANCELLED_BY_CUSTOMER');
      }
    });

    it('releases fuel on request and is safe to repeat', async () => {
      const order = await newOrder({ quantity: '10' });

      const first = await call(`/admin/orders/${order.id}/release`, {
        method: 'POST',
        body: { reason: 'Freeing capacity for a priority order' },
        token: adminToken,
      });

      assert.equal(first.status, 200);
      assert.equal(first.body.data.reservation.status, 'RELEASED');

      // The cancel endpoint and the sweeper race this routinely; a second
      // release must not double-subtract.
      const second = await call(`/admin/orders/${order.id}/release`, {
        method: 'POST',
        body: { reason: 'Again' },
        token: adminToken,
      });

      assert.equal(second.status, 200);
      assert.equal(second.body.data.reservation, null);
    });

    it('holds fuel again after a release', async () => {
      const order = await newOrder({ quantity: '10' });

      await call(`/admin/orders/${order.id}/release`, {
        method: 'POST',
        body: { reason: 'Releasing' },
        token: adminToken,
      });

      const { status, body } = await call(`/admin/orders/${order.id}/reserve`, {
        method: 'POST',
        body: { vehicleId: vehicleIds[0] },
        token: adminToken,
      });

      assert.equal(status, 201, JSON.stringify(body));
      assert.equal(body.data.reservation.status, 'HELD');
    });

    it('refuses a second live reservation for one order (INV-06)', async () => {
      const order = await newOrder({ quantity: '10' });

      const { status, body } = await call(`/admin/orders/${order.id}/reserve`, {
        method: 'POST',
        body: { vehicleId: vehicleIds[0] },
        token: adminToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'RESERVATION_ALREADY_HELD');
    });

    // --- Sweepers -----------------------------------------------------------

    it('expires an unpaid order and returns its fuel (BR-1006)', async () => {
      const quote = await requestQuote({ quantity: '10' });
      const { body } = await placeOrder({ quoteId: quote.id, paymentMode: 'PREPAID_ONLINE' });
      const orderId = body.data.order.id;

      await prisma.order.update({
        where: { id: orderId },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const { expireLapsedOrders } =
        await import('../../src/modules/order/services/cancel-order.service.js');

      const result = await expireLapsedOrders();
      assert.ok(result.expired >= 1);

      const expired = await prisma.order.findUnique({ where: { id: orderId } });
      assert.equal(expired.status, 'EXPIRED');
      assert.ok(expired.cancelledAt);

      const reservation = await prisma.fuelReservation.findFirst({ where: { orderId } });
      assert.equal(reservation.status, 'EXPIRED');

      // SYSTEM appears in the timeline as itself. docs/03 §5: "when a
      // reservation is released automatically, the timeline must show that,
      // not an unexplained gap".
      const events = await prisma.orderStatusEvent.findMany({
        where: { orderId },
        orderBy: { occurredAt: 'asc' },
      });

      const last = events.at(-1);
      assert.equal(last.toStatus, 'EXPIRED');
      assert.equal(last.actorKind, 'SYSTEM');
      assert.equal(last.actorUserId, null);
      assert.ok(last.reason.length > 0);
    });

    it('sweeps lapsed reservations (BR-407)', async () => {
      const order = await newOrder({ quantity: '10' });

      await prisma.fuelReservation.updateMany({
        where: { orderId: order.id, status: 'HELD' },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });

      const { sweepExpired } =
        await import('../../src/modules/dispatch/services/reservation.service.js');

      const result = await sweepExpired();
      assert.ok(result.released >= 1);

      const reservation = await prisma.fuelReservation.findFirst({
        where: { orderId: order.id },
      });

      assert.equal(reservation.status, 'EXPIRED');
      assert.equal(reservation.releaseReason, 'SWEPT_EXPIRED');
    });

    // --- Soft duplicate (BR-804) -------------------------------------------

    it('warns about an identical recent order, and allows an override', async () => {
      const quantity = '7';
      await newOrder({ quantity });

      const quote = await requestQuote({ quantity });

      const warned = await call('/orders', {
        method: 'POST',
        body: { quoteId: quote.id, paymentMode: 'CASH_ON_DELIVERY' },
        token: customerToken,
        headers: { 'idempotency-key': randomUUID() },
      });

      assert.equal(warned.status, 409);
      assert.equal(warned.body.error.code, 'DUPLICATE_ORDER');
      assert.ok(warned.body.error.details.existingOrderNumber);

      // A warning, not a refusal: the customer confirms and it proceeds.
      const confirmed = await call('/orders', {
        method: 'POST',
        body: { quoteId: quote.id, paymentMode: 'CASH_ON_DELIVERY', acknowledgeDuplicate: true },
        token: customerToken,
        headers: { 'idempotency-key': randomUUID() },
      });

      assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    });
  }
);
