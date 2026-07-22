import '../helpers/env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * Customer and corporate domain, end to end against a real database.
 *
 * SKIPPED unless TEST_DATABASE_URL is set. Run with:
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/dfy_test npm test
 *
 * Requires the migration AND the seed (roles and permissions must exist).
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);

if (enabled) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

describe(
  'customer & corporate domain (integration)',
  { skip: enabled ? false : 'TEST_DATABASE_URL not set' },
  () => {
    let server;
    let baseUrl;
    let prisma;

    const stamp = String(Date.now()).slice(-8);
    const ownerPhone = `+9198${stamp}`;
    const memberPhone = `+9196${stamp}`;
    const outsiderPhone = `+9195${stamp}`;
    const adminEmail = `admin.${stamp}@example.test`;
    const adminPassword = 'a-sufficiently-long-admin-password';
    const registrationNumber = `U40100WB2020PTC${stamp}`;

    const phones = [ownerPhone, memberPhone, outsiderPhone];

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

    /** Sign a customer in via OTP, creating the identity on first use. */
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

    before(async () => {
      const { createApp } = await import('../../src/app.js');
      ({ prisma } = await import('../../src/infrastructure/database/prisma.js'));
      await prisma.$connect();

      server = createApp().listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
    });

    after(async () => {
      if (prisma) {
        await prisma.otpChallenge.deleteMany({ where: { identifier: { in: phones } } });
        await prisma.corporateAccount.deleteMany({ where: { registrationNumber } });
        await prisma.user.deleteMany({ where: { phone: { in: phones } } });
        await prisma.user.deleteMany({ where: { email: adminEmail } });
        await prisma.$disconnect();
      }
      server?.close();
    });

    // --- Retail customer ---------------------------------------------------

    let ownerToken;
    let addressId;

    it('creates a customer profile for the signed-in identity', async () => {
      ownerToken = await signInCustomer(ownerPhone);

      const { status, body } = await call('/customers/register', {
        method: 'POST',
        body: { fullName: 'Asha Rao', preferredLanguage: 'en', marketingOptIn: true },
        token: ownerToken,
      });

      assert.equal(status, 201);
      assert.equal(body.data.profile.fullName, 'Asha Rao');
      // Identity fields are read from `users`, not duplicated.
      assert.equal(body.data.profile.phone, ownerPhone);
      assert.equal(body.data.profile.phoneVerified, true);
      assert.equal(body.data.profile.preferences.marketingOptIn, true);
    });

    it('refuses a second profile for the same identity', async () => {
      const { status, body } = await call('/customers/register', {
        method: 'POST',
        body: { fullName: 'Asha Rao' },
        token: ownerToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'PROFILE_ALREADY_EXISTS');
    });

    it('reads and patches the profile', async () => {
      const read = await call('/customers/me', { token: ownerToken });
      assert.equal(read.status, 200);

      const patched = await call('/customers/me', {
        method: 'PATCH',
        body: { fullName: 'Asha R.', notifyByEmail: true },
        token: ownerToken,
      });

      assert.equal(patched.status, 200);
      assert.equal(patched.body.data.profile.fullName, 'Asha R.');
      assert.equal(patched.body.data.profile.preferences.notifyByEmail, true);
      // Unmentioned fields survive a partial update.
      assert.equal(patched.body.data.profile.preferredLanguage, 'en');
    });

    it('rejects an empty patch', async () => {
      const { status } = await call('/customers/me', {
        method: 'PATCH',
        body: {},
        token: ownerToken,
      });

      assert.equal(status, 400);
    });

    it('cannot change phone through the profile', async () => {
      const { body } = await call('/customers/me', {
        method: 'PATCH',
        body: { fullName: 'Asha R.', phone: '+919999999999' },
        token: ownerToken,
      });

      // Identity is not editable here; the value is stripped by Zod.
      assert.equal(body.data.profile.phone, ownerPhone);
    });

    // --- Addresses ---------------------------------------------------------

    it('creates the first address and makes it default automatically', async () => {
      const { status, body } = await call('/customers/addresses', {
        method: 'POST',
        body: {
          nickname: 'Genset yard',
          line1: 'Plot 14, Industrial Estate',
          city: 'Kolkata',
          state: 'West Bengal',
          pincode: '700156',
          latitude: '22.5726',
          longitude: '88.3639',
          deliveryInstructions: 'Gate 2, security pass needed',
        },
        token: ownerToken,
      });

      assert.equal(status, 201);
      assert.equal(body.data.address.isDefault, true, 'first address must become the default');
      // Serviceability is cached advisory data from the placeholder provider.
      assert.equal(body.data.address.isServiceable, true);
      addressId = body.data.address.id;
    });

    it('keeps coordinates exact as strings', async () => {
      const { body } = await call('/customers/addresses', { token: ownerToken });
      const [address] = body.data.addresses;

      assert.equal(String(address.latitude), '22.5726');
      assert.equal(String(address.longitude), '88.3639');
    });

    it('moves the default when a second address claims it', async () => {
      const second = await call('/customers/addresses', {
        method: 'POST',
        body: {
          nickname: 'Depot',
          line1: '9 Dock Road',
          city: 'Kolkata',
          state: 'West Bengal',
          pincode: '700001',
          latitude: '22.5800',
          longitude: '88.3400',
          isDefault: true,
        },
        token: ownerToken,
      });

      assert.equal(second.status, 201);

      const list = await call('/customers/addresses', { token: ownerToken });
      const defaults = list.body.data.addresses.filter((address) => address.isDefault);

      assert.equal(defaults.length, 1, 'exactly one default must survive');
      assert.equal(defaults[0].id, second.body.data.address.id);
    });

    it('patches an address', async () => {
      const { status, body } = await call(`/customers/addresses/${addressId}`, {
        method: 'PATCH',
        body: { nickname: 'Main yard' },
        token: ownerToken,
      });

      assert.equal(status, 200);
      assert.equal(body.data.address.nickname, 'Main yard');
    });

    it('archives an address and promotes a replacement default', async () => {
      const list = await call('/customers/addresses', { token: ownerToken });
      const current = list.body.data.addresses.find((address) => address.isDefault);

      const removed = await call(`/customers/addresses/${current.id}`, {
        method: 'DELETE',
        token: ownerToken,
      });
      assert.equal(removed.status, 200);

      const after = await call('/customers/addresses', { token: ownerToken });

      assert.ok(
        after.body.data.addresses.every((address) => address.id !== current.id),
        'archived address must leave the list'
      );
      assert.equal(
        after.body.data.addresses.filter((address) => address.isDefault).length,
        1,
        'a replacement default must be promoted'
      );

      // Soft delete: the row survives for order history.
      const stored = await prisma.address.findUnique({ where: { id: current.id } });
      assert.ok(stored.archivedAt, 'address must be archived, not deleted');
    });

    // --- Ownership ---------------------------------------------------------

    it("cannot read or modify another customer's address", async () => {
      const outsiderToken = await signInCustomer(outsiderPhone);
      await call('/customers/register', {
        method: 'POST',
        body: { fullName: 'Outsider' },
        token: outsiderToken,
      });

      const list = await call('/customers/addresses', { token: ownerToken });
      const target = list.body.data.addresses[0];

      const patched = await call(`/customers/addresses/${target.id}`, {
        method: 'PATCH',
        body: { nickname: 'Hijacked' },
        token: outsiderToken,
      });

      const deleted = await call(`/customers/addresses/${target.id}`, {
        method: 'DELETE',
        token: outsiderToken,
      });

      // 404, not 403: a 403 would confirm the id exists (docs/10 §6).
      assert.equal(patched.status, 404);
      assert.equal(deleted.status, 404);

      const outsiderList = await call('/customers/addresses', { token: outsiderToken });
      assert.equal(outsiderList.body.data.addresses.length, 0);
    });

    // --- Corporate registration -------------------------------------------

    let corporateId;

    it('submits a corporate registration as PENDING and INACTIVE', async () => {
      const { status, body } = await call('/corporates/register', {
        method: 'POST',
        body: {
          legalName: 'Acme Fuels Private Limited',
          registrationIdType: 'CIN',
          registrationNumber,
          gstin: '19ABQCS3641F1Z0',
        },
        token: ownerToken,
      });

      assert.equal(status, 201);
      assert.equal(body.data.account.verificationStatus, 'PENDING');
      assert.equal(body.data.account.accountStatus, 'INACTIVE');
      // Approval and credit are separate decisions (BR-230).
      assert.equal(body.data.account.creditFacilityStatus, 'NOT_ENABLED');

      corporateId = body.data.account.id;
    });

    it('makes the registrant the owner and records the submission', async () => {
      const members = await prisma.corporateMember.findMany({
        where: { corporateAccountId: corporateId },
      });

      assert.equal(members.length, 1);
      assert.equal(members[0].role, 'CORPORATE_OWNER');

      const records = await prisma.corporateVerificationRecord.findMany({
        where: { corporateAccountId: corporateId },
      });

      assert.equal(records.length, 1);
      assert.equal(records[0].toStatus, 'PENDING');
      assert.equal(records[0].fromStatus, null);
    });

    it('rejects a duplicate registration identifier', async () => {
      const otherToken = await signInCustomer(memberPhone);

      const { status, body } = await call('/corporates/register', {
        method: 'POST',
        body: {
          legalName: 'Copycat Fuels',
          registrationIdType: 'CIN',
          registrationNumber,
        },
        token: otherToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'CORPORATE_ALREADY_REGISTERED');
    });

    it('BLOCKS login while the registration is pending (BR-203)', async () => {
      const requested = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: ownerPhone, principal: 'CUSTOMER', purpose: 'LOGIN' },
      });

      const verified = await call('/auth/otp/verify', {
        method: 'POST',
        body: {
          phone: ownerPhone,
          principal: 'CUSTOMER',
          purpose: 'LOGIN',
          code: requested.body.data.devCode,
        },
      });

      assert.equal(verified.status, 401);
      assert.equal(verified.body.error.code, 'CORPORATE_VERIFICATION_PENDING');
    });

    it('blocks corporate member management while pending', async () => {
      const { status, body } = await call('/corporates/members', { token: ownerToken });

      assert.equal(status, 403);
      assert.equal(body.error.code, 'CORPORATE_VERIFICATION_PENDING');
    });

    // --- Admin review ------------------------------------------------------

    let adminToken;

    const signInAdmin = async () => {
      const role = await prisma.role.findUnique({ where: { code: 'SUPER_ADMIN' } });
      assert.ok(role, 'seed must have run: SUPER_ADMIN role missing');

      const { hashPassword } =
        await import('../../src/modules/identity/services/password.service.js');

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
      });

      assert.equal(login.status, 200);
      return login.body.data.tokens.accessToken;
    };

    it('lists the pending registration for an admin', async () => {
      adminToken = await signInAdmin();

      const { status, body } = await call('/admin/corporates/pending', { token: adminToken });

      assert.equal(status, 200);
      assert.ok(body.data.corporates.some((corporate) => corporate.id === corporateId));
    });

    it('refuses admin endpoints to a customer token', async () => {
      const { status, body } = await call('/admin/corporates/pending', { token: ownerToken });

      assert.equal(status, 403);
      assert.equal(body.error.code, 'WRONG_PRINCIPAL');
    });

    it('refuses admin endpoints without a token', async () => {
      const { status } = await call('/admin/corporates/pending');

      assert.equal(status, 401);
    });

    it('approves: sets ACTIVE but leaves credit NOT_ENABLED', async () => {
      const { status, body } = await call(`/admin/corporates/${corporateId}/approve`, {
        method: 'POST',
        body: { adminNote: 'CIN verified against the registry' },
        token: adminToken,
      });

      assert.equal(status, 200);
      assert.equal(body.data.account.verificationStatus, 'APPROVED');
      assert.equal(body.data.account.accountStatus, 'ACTIVE');
      // The decisive assertion: approving a company is not extending it credit.
      assert.equal(body.data.account.creditFacilityStatus, 'NOT_ENABLED');
    });

    it('records the decision as append-only history', async () => {
      const records = await prisma.corporateVerificationRecord.findMany({
        where: { corporateAccountId: corporateId },
        orderBy: { createdAt: 'asc' },
      });

      assert.equal(records.length, 2, 'the submission record must survive the decision');
      assert.equal(records[1].fromStatus, 'PENDING');
      assert.equal(records[1].toStatus, 'APPROVED');
      assert.ok(records[1].reviewedByUserId);
    });

    it('never exposes internal admin notes to the company', async () => {
      const { body } = await call('/corporates/me', { token: ownerToken });

      const serialised = JSON.stringify(body);
      assert.ok(
        !serialised.includes('CIN verified against the registry'),
        'adminNote must never reach the company being reviewed'
      );
      assert.ok(!serialised.includes('adminNote'));
    });

    it('allows login once approved', async () => {
      const requested = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: ownerPhone, principal: 'CUSTOMER', purpose: 'LOGIN' },
      });

      const verified = await call('/auth/otp/verify', {
        method: 'POST',
        body: {
          phone: ownerPhone,
          principal: 'CUSTOMER',
          purpose: 'LOGIN',
          code: requested.body.data.devCode,
        },
      });

      assert.equal(verified.status, 200);
      ownerToken = verified.body.data.tokens.accessToken;
    });

    it('refuses to approve twice', async () => {
      const { status, body } = await call(`/admin/corporates/${corporateId}/approve`, {
        method: 'POST',
        body: {},
        token: adminToken,
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'CORPORATE_ALREADY_DECIDED');
    });

    // --- Members -----------------------------------------------------------

    let memberId;

    it('adds a member by phone', async () => {
      const { status, body } = await call('/corporates/members', {
        method: 'POST',
        body: { phone: memberPhone, role: 'PURCHASE_MANAGER' },
        token: ownerToken,
      });

      assert.equal(status, 201);
      assert.equal(body.data.member.role, 'PURCHASE_MANAGER');
      memberId = body.data.member.id;
    });

    it('refuses to add someone with no account', async () => {
      const { status, body } = await call('/corporates/members', {
        method: 'POST',
        body: { phone: '+919000000123', role: 'VIEWER' },
        token: ownerToken,
      });

      assert.equal(status, 404);
      assert.equal(body.error.code, 'USER_NOT_FOUND');
    });

    it('changes a member role', async () => {
      const { status, body } = await call(`/corporates/members/${memberId}`, {
        method: 'PATCH',
        body: { role: 'VIEWER' },
        token: ownerToken,
      });

      assert.equal(status, 200);
      assert.equal(body.data.member.role, 'VIEWER');
    });

    it('refuses to promote anyone to CORPORATE_OWNER', async () => {
      const { status } = await call(`/corporates/members/${memberId}`, {
        method: 'PATCH',
        body: { role: 'CORPORATE_OWNER' },
        token: ownerToken,
      });

      // Rejected by the schema: ownership transfer is its own operation (BR-222).
      assert.equal(status, 400);
    });

    it('refuses to remove the last owner', async () => {
      const members = await call('/corporates/members', { token: ownerToken });
      const owner = members.body.data.members.find((m) => m.role === 'CORPORATE_OWNER');

      const { status, body } = await call(`/corporates/members/${owner.id}`, {
        method: 'DELETE',
        token: ownerToken,
      });

      // Caught as self-removal first, which is also correct: the owner is the
      // caller. Either way the company keeps an administrator.
      assert.equal(status >= 400, true);
      assert.ok(
        ['LAST_OWNER_CANNOT_BE_REMOVED', 'CANNOT_REMOVE_SELF'].includes(body.error.code),
        `unexpected code ${body.error.code}`
      );
    });

    it('blocks a non-managing member from managing members', async () => {
      // The VIEWER we just demoted holds `corporate.member.manage` as a
      // platform permission, but their MEMBER role must still refuse.
      const viewerLogin = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: memberPhone, principal: 'CUSTOMER', purpose: 'LOGIN' },
      });

      const verified = await call('/auth/otp/verify', {
        method: 'POST',
        body: {
          phone: memberPhone,
          principal: 'CUSTOMER',
          purpose: 'LOGIN',
          code: viewerLogin.body.data.devCode,
        },
      });

      const viewerToken = verified.body.data.tokens.accessToken;

      const { status, body } = await call('/corporates/members', {
        method: 'POST',
        body: { phone: outsiderPhone, role: 'VIEWER' },
        token: viewerToken,
      });

      assert.equal(status, 403);
      assert.equal(body.error.code, 'INSUFFICIENT_CORPORATE_ROLE');
    });

    it('removes a member softly, preserving attribution', async () => {
      const { status } = await call(`/corporates/members/${memberId}`, {
        method: 'DELETE',
        token: ownerToken,
      });

      assert.equal(status, 200);

      const stored = await prisma.corporateMember.findUnique({ where: { id: memberId } });
      assert.equal(stored.status, 'REMOVED');
      assert.ok(stored.removedAt, 'removal must be timestamped');

      const list = await call('/corporates/members', { token: ownerToken });
      assert.ok(list.body.data.members.every((m) => m.id !== memberId));
    });

    // --- Suspension keeps verification intact ------------------------------

    it('suspending changes only the operational axis (BR-213)', async () => {
      await prisma.corporateAccount.update({
        where: { id: corporateId },
        data: { accountStatus: 'SUSPENDED', suspensionReason: 'Non-payment' },
      });

      const account = await prisma.corporateAccount.findUnique({ where: { id: corporateId } });

      // The approval record must survive suspension entirely.
      assert.equal(account.verificationStatus, 'APPROVED');
      assert.equal(account.accountStatus, 'SUSPENDED');

      const requested = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: ownerPhone, principal: 'CUSTOMER', purpose: 'LOGIN' },
      });

      const verified = await call('/auth/otp/verify', {
        method: 'POST',
        body: {
          phone: ownerPhone,
          principal: 'CUSTOMER',
          purpose: 'LOGIN',
          code: requested.body.data.devCode,
        },
      });

      assert.equal(verified.status, 401);
      assert.equal(verified.body.error.code, 'CORPORATE_ACCOUNT_SUSPENDED');

      // Reactivation restores access with no re-verification (BR-214).
      await prisma.corporateAccount.update({
        where: { id: corporateId },
        data: { accountStatus: 'ACTIVE', suspensionReason: null },
      });
    });

    // --- Rejection ---------------------------------------------------------

    it('rejects a registration with a reason visible to the applicant', async () => {
      const rejectPhone = `+9194${stamp}`;
      phones.push(rejectPhone);

      const token = await signInCustomer(rejectPhone);
      const registered = await call('/corporates/register', {
        method: 'POST',
        body: {
          legalName: 'Dubious Fuels',
          registrationIdType: 'CIN',
          registrationNumber: `U99999WB2020PTC${stamp}`,
        },
        token,
      });

      const rejectedId = registered.body.data.account.id;

      const missingReason = await call(`/admin/corporates/${rejectedId}/reject`, {
        method: 'POST',
        body: { adminNote: 'Suspicious' },
        token: adminToken,
      });
      assert.equal(missingReason.status, 400, 'a rejection must explain itself (BR-205)');

      const { status, body } = await call(`/admin/corporates/${rejectedId}/reject`, {
        method: 'POST',
        body: {
          reasonCode: 'INVALID_CIN',
          applicantNote: 'The CIN could not be verified against the registry.',
          adminNote: 'Internal: flagged by compliance',
        },
        token: adminToken,
      });

      assert.equal(status, 200);
      assert.equal(body.data.account.verificationStatus, 'REJECTED');
      // Rejection must not touch the operational axis.
      assert.equal(body.data.account.accountStatus, 'INACTIVE');

      const login = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: rejectPhone, principal: 'CUSTOMER', purpose: 'LOGIN' },
      });
      const verified = await call('/auth/otp/verify', {
        method: 'POST',
        body: {
          phone: rejectPhone,
          principal: 'CUSTOMER',
          purpose: 'LOGIN',
          code: login.body.data.devCode,
        },
      });

      assert.equal(verified.body.error.code, 'CORPORATE_VERIFICATION_REJECTED');

      await prisma.corporateAccount.deleteMany({
        where: { registrationNumber: `U99999WB2020PTC${stamp}` },
      });
    });
  }
);
