import '../helpers/env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * Pricing & catalogue, end to end against a real database.
 *
 * SKIPPED unless TEST_DATABASE_URL is set. Requires the migration AND the seed.
 *
 * The cases that matter most here are the ones a unit test cannot prove:
 * that the price timeline is enforced by PostgreSQL rather than by hopeful
 * service code, and that a quote written yesterday is unaffected by a price
 * published today.
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);

if (enabled) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

describe(
  'pricing & catalogue (integration)',
  { skip: enabled ? false : 'TEST_DATABASE_URL not set' },
  () => {
    let server;
    let baseUrl;
    let prisma;

    let superToken; // SUPER_ADMIN: holds price.approve
    let adminToken; // ADMIN: deliberately does NOT hold price.approve
    let customerToken;

    const stamp = String(Date.now()).slice(-8);
    const superEmail = `pricing.super.${stamp}@example.test`;
    const adminEmail = `pricing.admin.${stamp}@example.test`;
    const password = 'a-sufficiently-long-admin-password';
    const customerPhone = `+9194${stamp}`;
    const otherPhone = `+9191${stamp}`;
    const productCode = `HSD_${stamp}`;
    const taxCodes = [`VAT_${stamp}`, `EXCISE_${stamp}`, `CGST_${stamp}`, `SGST_${stamp}`];
    const city = `Testville${stamp}`;
    const state = 'West Bengal';

    let productId;
    let addressId;
    let firstPriceId;

    const call = async (path, { method = 'GET', body, token } = {}) => {
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
      return verified.body.data.tokens.accessToken;
    };

    const signInAdmin = async (email, roleCode) => {
      const { hashPassword } =
        await import('../../src/modules/identity/services/password.service.js');
      const role = await prisma.role.findUnique({ where: { code: roleCode } });
      assert.ok(role, `seed must have run: ${roleCode} role missing`);

      await prisma.user.create({
        data: {
          principal: 'ADMIN',
          email,
          passwordHash: await hashPassword(password),
          emailVerifiedAt: new Date(),
          roles: { create: { roleId: role.id } },
        },
      });

      const login = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'ADMIN', email, password },
      });

      assert.equal(login.status, 200);
      return login.body.data.tokens.accessToken;
    };

    before(async () => {
      const { createApp } = await import('../../src/app.js');
      ({ prisma } = await import('../../src/infrastructure/database/prisma.js'));
      await prisma.$connect();

      server = createApp().listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;

      superToken = await signInAdmin(superEmail, 'SUPER_ADMIN');
      adminToken = await signInAdmin(adminEmail, 'ADMIN');
      customerToken = await signInCustomer(customerPhone);

      const address = await call('/customers/addresses', {
        method: 'POST',
        body: {
          nickname: 'Genset yard',
          line1: '14 Test Road',
          city,
          state,
          pincode: '700156',
          latitude: '22.5726',
          longitude: '88.3639',
        },
        token: customerToken,
      });

      assert.equal(address.status, 201, JSON.stringify(address.body));
      addressId = address.body.data.address.id;
    });

    after(async () => {
      if (prisma) {
        // Order matters: quotes reference prices, prices reference products.
        await prisma.quote.deleteMany({ where: { city } });
        await prisma.fuelPrice.deleteMany({ where: { city } });
        await prisma.fuelProduct.deleteMany({ where: { code: productCode } });
        await prisma.taxRule.deleteMany({ where: { code: { in: taxCodes } } });
        await prisma.deliveryChargeRule.deleteMany({ where: { city } });
        await prisma.otpChallenge.deleteMany({
          where: { identifier: { in: [customerPhone, otherPhone] } },
        });
        await prisma.user.deleteMany({
          where: {
            OR: [
              { phone: { in: [customerPhone, otherPhone] } },
              { email: { in: [superEmail, adminEmail] } },
            ],
          },
        });
        await prisma.$disconnect();
      }
      server?.close();
    });

    // --- Catalogue ---------------------------------------------------------

    it('creates a fuel product', async () => {
      const { status, body } = await call('/admin/products', {
        method: 'POST',
        body: {
          code: productCode,
          name: 'High-Speed Diesel',
          hsnCode: '27101944',
          unit: 'LITRE',
        },
        token: adminToken,
      });

      assert.equal(status, 201);
      assert.equal(body.data.product.code, productCode.toUpperCase());
      productId = body.data.product.id;
    });

    it('refuses a duplicate product code', async () => {
      const { status, body } = await call('/admin/products', {
        method: 'POST',
        body: { code: productCode, name: 'Duplicate' },
        token: adminToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'PRODUCT_CODE_TAKEN');
    });

    it('configures the two tax regimes as data, not constants', async () => {
      const rules = [
        {
          name: 'State VAT (diesel)',
          code: taxCodes[0],
          regime: 'VAT_EXCISE',
          appliesTo: 'FUEL',
          isInclusive: true,
          calculationType: 'PERCENTAGE',
          rate: '24',
          state,
          sequence: 20,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
        {
          name: 'Central excise (diesel)',
          code: taxCodes[1],
          regime: 'VAT_EXCISE',
          appliesTo: 'FUEL',
          isInclusive: true,
          calculationType: 'PER_UNIT',
          rate: '15.80',
          state,
          sequence: 10,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
        {
          name: 'CGST (delivery)',
          code: taxCodes[2],
          regime: 'GST',
          appliesTo: 'DELIVERY',
          isInclusive: false,
          rate: '9',
          sacCode: '996511',
          state,
          sequence: 10,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
        {
          name: 'SGST (delivery)',
          code: taxCodes[3],
          regime: 'GST',
          appliesTo: 'DELIVERY',
          isInclusive: false,
          rate: '9',
          sacCode: '996511',
          state,
          sequence: 20,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
      ];

      for (const rule of rules) {
        const { status } = await call('/admin/taxes', {
          method: 'POST',
          body: rule,
          token: adminToken,
        });

        assert.equal(status, 201, rule.code);
      }
    });

    it('rejects a percentage tax above 100', async () => {
      const { status } = await call('/admin/taxes', {
        method: 'POST',
        body: {
          name: 'Impossible',
          code: `BAD_${stamp}`,
          regime: 'GST',
          appliesTo: 'DELIVERY',
          isInclusive: false,
          rate: '180',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
        token: adminToken,
      });

      assert.equal(status, 400);
    });

    it('creates a delivery charge rule scoped to the city', async () => {
      const { status, body } = await call('/admin/delivery-charges', {
        method: 'POST',
        body: {
          name: 'Standard delivery',
          city,
          flatCharge: '250.00',
          minQuantity: '0',
          minimumOrderQuantity: '20',
          freeAboveOrderValue: '50000.00',
          sacCode: '996511',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
        token: adminToken,
      });

      assert.equal(status, 201);
      // Money crosses the wire as a string, at a fixed scale.
      assert.equal(body.data.deliveryChargeRule.flatCharge, '250.00');
    });

    // --- Price versioning --------------------------------------------------

    it('publishes the first price', async () => {
      const { status, body } = await call('/admin/prices', {
        method: 'POST',
        body: { productId, city, pricePerUnit: '94.7700' },
        token: adminToken,
      });

      assert.equal(status, 201);
      assert.equal(body.data.price.status, 'ACTIVE');
      assert.equal(body.data.price.effectiveUntil, null);
      assert.equal(body.data.warning, undefined);
      firstPriceId = body.data.price.id;
    });

    it('refuses a backdated price - it would rewrite what past quotes cost', async () => {
      const { status, body } = await call('/admin/prices', {
        method: 'POST',
        body: {
          productId,
          city,
          pricePerUnit: '90.0000',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
        },
        token: adminToken,
      });

      assert.equal(status, 400);
      assert.equal(body.error.code, 'PRICE_EFFECTIVE_IN_PAST');
    });

    it('holds an out-of-band price for a second administrator (BR-607)', async () => {
      // A misplaced decimal point: 947.70 instead of 94.77.
      const { status, body } = await call('/admin/prices', {
        method: 'POST',
        body: { productId, city, pricePerUnit: '947.7000' },
        token: adminToken,
      });

      assert.equal(status, 201);
      // Parked, NOT rejected - a real 25% move during a fuel crisis must be
      // possible, it just should not be one person's typo away from live.
      assert.equal(body.data.price.status, 'PENDING_APPROVAL');
      assert.equal(body.data.warning.code, 'PRICE_OUT_OF_SANITY_BAND');

      // And the live price is untouched.
      const active = await prisma.fuelPrice.findFirst({
        where: { productId, city, status: 'ACTIVE' },
      });
      assert.equal(active.id, firstPriceId);

      // Clean it up so it cannot interfere with later cases.
      await call(`/admin/prices/${body.data.price.id}/status`, {
        method: 'PATCH',
        body: { status: 'CANCELLED' },
        token: adminToken,
      });
    });

    it('will not let the author approve their own out-of-band price', async () => {
      const created = await call('/admin/prices', {
        method: 'POST',
        body: { productId, city, pricePerUnit: '947.7000' },
        token: superToken,
      });

      assert.equal(created.body.data.price.status, 'PENDING_APPROVAL');

      // Same administrator, and they DO hold price.approve. Separation of
      // duties is what stops this, not a missing grant.
      const { status, body } = await call(`/admin/prices/${created.body.data.price.id}/status`, {
        method: 'PATCH',
        body: { status: 'ACTIVE' },
        token: superToken,
      });

      assert.equal(status, 403);
      assert.equal(body.error.code, 'SELF_APPROVAL_FORBIDDEN');

      await call(`/admin/prices/${created.body.data.price.id}/status`, {
        method: 'PATCH',
        body: { status: 'CANCELLED' },
        token: superToken,
      });
    });

    it('will not let a plain ADMIN approve an out-of-band price', async () => {
      const created = await call('/admin/prices', {
        method: 'POST',
        body: { productId, city, pricePerUnit: '947.7000' },
        token: superToken,
      });

      // A different administrator, but ADMIN is not granted price.approve.
      const { status, body } = await call(`/admin/prices/${created.body.data.price.id}/status`, {
        method: 'PATCH',
        body: { status: 'ACTIVE' },
        token: adminToken,
      });

      assert.equal(status, 403);
      assert.equal(body.error.code, 'INSUFFICIENT_PERMISSIONS');

      await call(`/admin/prices/${created.body.data.price.id}/status`, {
        method: 'PATCH',
        body: { status: 'CANCELLED' },
        token: superToken,
      });
    });

    /**
     * BR-602, the guarantee rather than the happy path.
     *
     * Bypasses the service entirely and writes straight to the table, because
     * the service's read-then-insert is exactly what a concurrent publish
     * defeats. If this INSERT succeeds, two live rates exist and the quote
     * engine's answer depends on row order.
     */
    it('makes two overlapping active prices impossible at the database level', async () => {
      await assert.rejects(
        prisma.fuelPrice.create({
          data: {
            productId,
            city,
            pricePerUnit: '99.0000',
            effectiveFrom: new Date(),
            status: 'ACTIVE',
            // findFirst, not findUnique: email alone is not unique - an
            // address is unique per (email, principal).
            createdByUserId: (await prisma.user.findFirst({ where: { email: adminEmail } })).id,
          },
        }),
        /fuel_prices_no_overlapping_active_window|exclusion constraint/i
      );
    });

    it('never overwrites price history - a new version supersedes the old', async () => {
      const { status, body } = await call('/admin/prices', {
        method: 'POST',
        body: { productId, city, pricePerUnit: '96.5000' },
        token: adminToken,
      });

      assert.equal(status, 201);
      assert.equal(body.data.price.status, 'ACTIVE');

      const previous = await prisma.fuelPrice.findUnique({ where: { id: firstPriceId } });

      // The old row still exists, still carries its ORIGINAL rate, and its
      // window is now closed rather than deleted.
      assert.equal(previous.status, 'SUPERSEDED');
      assert.equal(previous.pricePerUnit.toString(), '94.77');
      assert.notEqual(previous.effectiveUntil, null);
      assert.equal(previous.supersededById, body.data.price.id);
    });

    // --- Quotes ------------------------------------------------------------

    let quoteId;
    let quotedTotal;

    it('generates a quote for a customer', async () => {
      const { status, body } = await call('/quotes', {
        method: 'POST',
        body: { addressId, productId, quantity: '100' },
        token: customerToken,
      });

      assert.equal(status, 201);

      const quote = body.data.quote;
      quoteId = quote.id;
      quotedTotal = quote.totalAmount;

      // 100 L at 96.50 inclusive, plus 250.00 delivery + 18% GST.
      assert.equal(quote.fuelAmount, '9650.00');
      assert.equal(quote.deliveryAmount, '295.00');
      assert.equal(quote.totalAmount, '9945.00');

      // Every amount is a string (ADR-015 / control M7).
      for (const field of [
        'quantity',
        'fuelAmount',
        'deliveryAmount',
        'taxAmount',
        'totalAmount',
      ]) {
        assert.equal(typeof quote[field], 'string', field);
      }
    });

    it('splits the invoice into a tax-inclusive fuel line and a tax-exclusive delivery line', () => {
      // Asserted from the stored breakdown rather than recomputed, so this
      // covers what was actually persisted onto the quote.
      return call(`/quotes/${quoteId}`, { token: customerToken }).then(({ body }) => {
        const [fuel, delivery] = body.data.quote.lines;

        assert.equal(fuel.kind, 'FUEL');
        assert.equal(fuel.isInclusive, true);
        assert.equal(fuel.regime, 'VAT_EXCISE');
        assert.equal(fuel.lineTotal, '9650.00');

        assert.equal(delivery.kind, 'DELIVERY');
        assert.equal(delivery.isInclusive, false);
        assert.equal(delivery.regime, 'GST');
        assert.equal(delivery.taxAmount, '45.00');
      });
    });

    it('locks the quote to a specific price version (BR-606)', async () => {
      const stored = await prisma.quote.findUnique({ where: { id: quoteId } });
      const active = await prisma.fuelPrice.findFirst({
        where: { productId, city, status: 'ACTIVE' },
      });

      assert.equal(stored.priceId, active.id);
    });

    it('refuses an order below the delivery minimum', async () => {
      const { status, body } = await call('/quotes', {
        method: 'POST',
        body: { addressId, productId, quantity: '5' },
        token: customerToken,
      });

      assert.equal(status, 400);
      assert.equal(body.error.code, 'BELOW_MINIMUM_ORDER_QUANTITY');
    });

    it('waives delivery above the free-delivery threshold', async () => {
      const { status, body } = await call('/quotes', {
        method: 'POST',
        body: { addressId, productId, quantity: '600' },
        token: customerToken,
      });

      assert.equal(status, 201);
      assert.equal(body.data.quote.deliveryWaived, true);
      assert.equal(body.data.quote.deliveryAmount, '0.00');
    });

    /**
     * THE headline requirement: "Changing today's price must never change
     * yesterday's quote."
     */
    it('leaves an existing quote untouched when the price changes', async () => {
      const published = await call('/admin/prices', {
        method: 'POST',
        body: { productId, city, pricePerUnit: '98.0000' },
        token: adminToken,
      });

      assert.equal(published.status, 201);

      const { body } = await call(`/quotes/${quoteId}`, { token: customerToken });

      assert.equal(body.data.quote.totalAmount, quotedTotal);
      assert.equal(body.data.quote.priceVersion.pricePerUnit, '96.5');
    });

    it('prices a new quote at the new rate', async () => {
      const { body } = await call('/quotes', {
        method: 'POST',
        body: { addressId, productId, quantity: '100' },
        token: customerToken,
      });

      assert.equal(body.data.quote.fuelAmount, '9800.00');
    });

    it('never exposes pricing history to a customer', async () => {
      const { body } = await call(`/quotes/${quoteId}`, { token: customerToken });
      const serialised = JSON.stringify(body.data.quote);

      // The quote's own rate is present; the superseded ones are not.
      assert.equal(body.data.quote.priceVersion.pricePerUnit, '96.5');
      assert.ok(!serialised.includes('94.77'), 'a superseded rate leaked into a quote');
      assert.ok(!serialised.includes('SUPERSEDED'));
      assert.ok(!serialised.includes('changePercent'));
      assert.ok(!serialised.includes('createdByUserId'));
    });

    it('returns an expired quote marked expired rather than hiding it (BR-605)', async () => {
      // Expire it directly - waiting out QUOTE_TTL_SECONDS is not a test.
      await prisma.quote.update({
        where: { id: quoteId },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      const { status, body } = await call(`/quotes/${quoteId}`, { token: customerToken });

      // 200, not 404: the client needs the old quote to build the "the price
      // changed from X to Y, confirm" screen.
      assert.equal(status, 200);
      assert.equal(body.data.quote.isExpired, true);
      assert.equal(body.data.quote.status, 'EXPIRED');
      assert.equal(body.data.quote.totalAmount, quotedTotal);
    });

    // --- Authorization -----------------------------------------------------

    it("hides another customer's quote behind a 404, not a 403", async () => {
      const otherToken = await signInCustomer(otherPhone);

      const { status } = await call(`/quotes/${quoteId}`, { token: otherToken });

      // 403 would confirm the id is real.
      assert.equal(status, 404);
    });

    it('refuses a quote against an address the caller does not own', async () => {
      const otherToken = await signInCustomer(otherPhone);

      const { status } = await call('/quotes', {
        method: 'POST',
        body: { addressId, productId, quantity: '100' },
        token: otherToken,
      });

      assert.equal(status, 404);
    });

    it('keeps customers out of every pricing administration endpoint', async () => {
      const endpoints = [
        ['GET', '/admin/products'],
        ['POST', '/admin/products'],
        ['GET', '/admin/prices'],
        ['POST', '/admin/prices'],
        ['GET', '/admin/taxes'],
        ['POST', '/admin/taxes'],
        ['GET', '/admin/delivery-charges'],
        ['POST', '/admin/delivery-charges'],
      ];

      for (const [method, path] of endpoints) {
        const { status } = await call(path, {
          method,
          // No body on GET - fetch refuses it, and the point of the case is
          // that the request never reaches validation anyway.
          body: method === 'POST' ? {} : undefined,
          token: customerToken,
        });

        assert.equal(status, 403, `${method} ${path}`);
      }
    });

    it('keeps admins out of the customer quote surface', async () => {
      const { status } = await call('/quotes', {
        method: 'POST',
        body: { addressId, productId, quantity: '100' },
        token: adminToken,
      });

      assert.equal(status, 403);
    });

    it('rejects an unauthenticated quote request', async () => {
      const { status } = await call('/quotes', {
        method: 'POST',
        body: { addressId, productId, quantity: '100' },
      });

      assert.equal(status, 401);
    });
  }
);
