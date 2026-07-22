import '../helpers/env.js';

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

/**
 * Full authentication flow against a real database.
 *
 * SKIPPED unless TEST_DATABASE_URL is set, so `npm test` stays green on a
 * machine with no database. Run with:
 *
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/dfy_test npm test
 *
 * The target database is migrated and seeded, and its `users` table is emptied
 * between runs. Point it at a scratch database, never at development data.
 */

const enabled = Boolean(process.env.TEST_DATABASE_URL);

if (enabled) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

describe(
  'authentication flow (integration)',
  { skip: enabled ? false : 'TEST_DATABASE_URL not set' },
  () => {
    let server;
    let baseUrl;
    let prisma;

    /** Unique per run so repeated runs do not collide on the phone unique index. */
    const phone = `+9198${String(Date.now()).slice(-8)}`;
    const otpPhone = `+9196${String(Date.now()).slice(-8)}`;
    const password = 'a-sufficiently-long-password';

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

    before(async () => {
      const { createApp } = await import('../../src/app.js');
      ({ prisma } = await import('../../src/infrastructure/database/prisma.js'));

      await prisma.$connect();

      server = createApp().listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
    });

    after(async () => {
      await prisma?.otpChallenge.deleteMany({ where: { identifier: otpPhone } });
      await prisma?.user.deleteMany({ where: { phone: { in: [phone, otpPhone] } } });
      await prisma?.$disconnect();
      server?.close();
    });

    let accessToken;
    let refreshToken;

    it('registers a new identity', async () => {
      const { status, body } = await call('/auth/register', {
        method: 'POST',
        body: { phone, password, consentVersion: '2026-07-01' },
      });

      assert.equal(status, 201);
      assert.equal(body.success, true);
      assert.equal(body.data.user.principal, 'CUSTOMER');
      assert.deepEqual(body.data.roles, ['CUSTOMER']);
      assert.ok(body.data.permissions.includes('user.read.self'));
      assert.ok(body.data.tokens.accessToken);
      assert.ok(body.data.tokens.refreshToken);
    });

    it('never returns a password hash', async () => {
      const { body } = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password },
      });

      assert.ok(!JSON.stringify(body).toLowerCase().includes('passwordhash'));
      assert.ok(!JSON.stringify(body).includes('$argon2'));
    });

    it('rejects a duplicate registration', async () => {
      const { status, body } = await call('/auth/register', {
        method: 'POST',
        body: { phone, password },
      });

      assert.equal(status, 409);
      assert.equal(body.error.code, 'ACCOUNT_ALREADY_EXISTS');
    });

    it('logs in with correct credentials', async () => {
      const { status, body } = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password },
      });

      assert.equal(status, 200);
      accessToken = body.data.tokens.accessToken;
      refreshToken = body.data.tokens.refreshToken;
      assert.ok(accessToken && refreshToken);
    });

    it('rejects a wrong password with the same code as an unknown account', async () => {
      const wrongPassword = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password: 'definitely-the-wrong-one' },
      });

      const unknownAccount = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone: '+919000000001', password },
      });

      // Identical responses: anything else lets an attacker enumerate accounts.
      assert.equal(wrongPassword.status, 401);
      assert.equal(unknownAccount.status, 401);
      assert.equal(wrongPassword.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(unknownAccount.body.error.code, 'INVALID_CREDENTIALS');
      assert.equal(wrongPassword.body.message, unknownAccount.body.message);
    });

    it('rejects login against the wrong principal', async () => {
      // The identity exists as a CUSTOMER. A driver-app login must not match it.
      const { status } = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'DRIVER', phone, password },
      });

      assert.equal(status, 401);
    });

    it('returns the current user', async () => {
      const { status, body } = await call('/auth/me', { token: accessToken });

      assert.equal(status, 200);
      assert.equal(body.data.user.phone, phone);
      assert.deepEqual(body.data.roles, ['CUSTOMER']);
    });

    it('rejects an unauthenticated request', async () => {
      const { status, body } = await call('/auth/me');

      assert.equal(status, 401);
      assert.equal(body.error.code, 'TOKEN_MISSING');
    });

    it('lists sessions and marks the current one', async () => {
      const { status, body } = await call('/auth/sessions', { token: accessToken });

      assert.equal(status, 200);
      assert.ok(body.data.sessions.length >= 1);
      assert.equal(
        body.data.sessions.some((session) => session.isCurrent),
        true
      );
      // The stored hash must never be exposed.
      assert.ok(!JSON.stringify(body).includes('refreshTokenHash'));
    });

    it('refreshes and rotates the refresh token', async () => {
      const { status, body } = await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
      });

      assert.equal(status, 200);
      assert.notEqual(body.data.tokens.refreshToken, refreshToken, 'token must rotate');

      const previousRefreshToken = refreshToken;
      refreshToken = body.data.tokens.refreshToken;
      accessToken = body.data.tokens.accessToken;

      // The superseded token is now a replay, and must revoke the session.
      const replay = await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: previousRefreshToken },
      });

      assert.equal(replay.status, 401);
      assert.equal(replay.body.error.code, 'TOKEN_REUSE_DETECTED');
    });

    it('revoked the session after reuse was detected', async () => {
      // The rotated token was valid, but its session was killed by the replay.
      const { status, body } = await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken },
      });

      assert.equal(status, 401);
      assert.equal(body.error.code, 'SESSION_REVOKED');
    });

    it('logs out a single session', async () => {
      const login = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password },
      });

      const tokens = login.body.data.tokens;

      const logout = await call('/auth/logout', { method: 'POST', token: tokens.accessToken });
      assert.equal(logout.status, 200);

      // The session is gone, so no new tokens can be obtained from it.
      const afterLogout = await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: tokens.refreshToken },
      });

      assert.equal(afterLogout.status, 401);
      assert.equal(afterLogout.body.error.code, 'SESSION_REVOKED');
    });

    it('logs out every session', async () => {
      const first = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password, deviceName: 'device-one' },
      });
      const second = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password, deviceName: 'device-two' },
      });

      const logoutAll = await call('/auth/logout-all', {
        method: 'POST',
        token: second.body.data.tokens.accessToken,
      });

      assert.equal(logoutAll.status, 200);
      assert.ok(logoutAll.body.data.revokedCount >= 2);

      // BOTH devices are now dead, including the one that issued the request.
      for (const login of [first, second]) {
        const { status } = await call('/auth/refresh', {
          method: 'POST',
          body: { refreshToken: login.body.data.tokens.refreshToken },
        });

        assert.equal(status, 401);
      }
    });

    it('revokes one device without affecting the others', async () => {
      const keep = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password, deviceName: 'keep' },
      });
      const drop = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password, deviceName: 'drop' },
      });

      const sessions = await call('/auth/sessions', { token: keep.body.data.tokens.accessToken });
      const target = sessions.body.data.sessions.find((session) => !session.isCurrent);

      const revoke = await call(`/auth/sessions/${target.id}`, {
        method: 'DELETE',
        token: keep.body.data.tokens.accessToken,
      });
      assert.equal(revoke.status, 200);

      const dropped = await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: drop.body.data.tokens.refreshToken },
      });
      assert.equal(dropped.status, 401);

      const kept = await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: keep.body.data.tokens.refreshToken },
      });
      assert.equal(kept.status, 200);
    });

    it('cannot revoke a session belonging to another user', async () => {
      const other = `+9197${String(Date.now()).slice(-8)}`;
      const registered = await call('/auth/register', {
        method: 'POST',
        body: { phone: other, password },
      });

      const mine = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password },
      });

      const theirSessions = await call('/auth/sessions', {
        token: registered.body.data.tokens.accessToken,
      });

      const attempt = await call(`/auth/sessions/${theirSessions.body.data.sessions[0].id}`, {
        method: 'DELETE',
        token: mine.body.data.tokens.accessToken,
      });

      // 404 not 403: a 403 would confirm the session id exists (docs/10 §6).
      assert.equal(attempt.status, 404);

      await prisma.user.deleteMany({ where: { phone: other } });
    });

    it('blocks a blocked account at login and at refresh', async () => {
      const login = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password },
      });

      await prisma.user.updateMany({ where: { phone }, data: { status: 'BLOCKED' } });

      const refreshAttempt = await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: login.body.data.tokens.refreshToken },
      });

      assert.equal(refreshAttempt.status, 401);
      assert.equal(refreshAttempt.body.error.code, 'ACCOUNT_BLOCKED');

      const loginAttempt = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password },
      });

      assert.equal(loginAttempt.status, 401);
      assert.equal(loginAttempt.body.error.code, 'ACCOUNT_BLOCKED');

      await prisma.user.updateMany({ where: { phone }, data: { status: 'ACTIVE' } });
    });

    // --- OTP: the customer authentication path (BR-101) --------------------

    /** The console provider returns the code, so tests can complete the flow. */
    /**
     * Age any live challenge past its resend cooldown.
     *
     * A test that submits a WRONG code leaves its challenge live, so the next
     * test's first request legitimately trips the 30-second cooldown. Ageing
     * the row is the honest fix: it keeps the cooldown real (the test that
     * asserts it does NOT call this before its second request) rather than
     * weakening the limit to make unrelated tests pass.
     */
    const clearResendCooldown = async () => {
      await prisma.otpChallenge.updateMany({
        where: { identifier: otpPhone, consumedAt: null },
        data: { createdAt: new Date(Date.now() - 600_000) },
      });
    };

    const requestCode = async (purpose = 'SIGNUP', { skipCooldown = true } = {}) => {
      if (skipCooldown) await clearResendCooldown();

      const { status, body } = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: otpPhone, principal: 'CUSTOMER', purpose },
      });

      assert.equal(status, 202, 'OTP request should be 202 Accepted');
      return body.data;
    };

    it('creates an identity on first successful OTP verification', async () => {
      const { devCode, expiresAt } = await requestCode('SIGNUP');

      assert.ok(devCode, 'console provider must expose the code outside production');
      assert.ok(new Date(expiresAt) > new Date());

      const { status, body } = await call('/auth/otp/verify', {
        method: 'POST',
        body: { phone: otpPhone, principal: 'CUSTOMER', purpose: 'SIGNUP', code: devCode },
      });

      assert.equal(status, 200);
      assert.equal(body.data.user.phone, otpPhone);
      // The code proved control of the number, which is what verification means.
      assert.equal(body.data.user.phoneVerified, true);
      assert.deepEqual(body.data.roles, ['CUSTOMER']);
      assert.ok(body.data.tokens.accessToken && body.data.tokens.refreshToken);
    });

    it('rejects a reused code (single use)', async () => {
      const { devCode } = await requestCode('LOGIN');

      const first = await call('/auth/otp/verify', {
        method: 'POST',
        body: { phone: otpPhone, principal: 'CUSTOMER', purpose: 'LOGIN', code: devCode },
      });
      assert.equal(first.status, 200);

      const replay = await call('/auth/otp/verify', {
        method: 'POST',
        body: { phone: otpPhone, principal: 'CUSTOMER', purpose: 'LOGIN', code: devCode },
      });

      assert.equal(replay.status, 401);
      assert.equal(replay.body.error.code, 'OTP_INVALID');
    });

    it('rejects a wrong code with the same error as an unknown challenge', async () => {
      const { devCode } = await requestCode('LOGIN');
      const wrong = devCode === '000000' ? '111111' : '000000';

      const wrongCode = await call('/auth/otp/verify', {
        method: 'POST',
        body: { phone: otpPhone, principal: 'CUSTOMER', purpose: 'LOGIN', code: wrong },
      });

      const noChallenge = await call('/auth/otp/verify', {
        method: 'POST',
        body: { phone: '+919000000009', principal: 'CUSTOMER', purpose: 'LOGIN', code: wrong },
      });

      // Identical: any difference would confirm whether a number is registered.
      assert.equal(wrongCode.status, 401);
      assert.equal(noChallenge.status, 401);
      assert.equal(wrongCode.body.error.code, 'OTP_INVALID');
      assert.equal(noChallenge.body.error.code, 'OTP_INVALID');
      assert.equal(wrongCode.body.message, noChallenge.body.message);
    });

    it('a resend invalidates the previous code', async () => {
      const first = await requestCode('LOGIN');

      // The resend is a genuine second send, so it must clear the cooldown
      // the first one just started.
      const second = await requestCode('LOGIN');
      assert.notEqual(second.devCode, first.devCode);

      const stale = await call('/auth/otp/verify', {
        method: 'POST',
        body: { phone: otpPhone, principal: 'CUSTOMER', purpose: 'LOGIN', code: first.devCode },
      });
      assert.equal(stale.status, 401, 'the superseded code must not work');

      const current = await call('/auth/otp/verify', {
        method: 'POST',
        body: { phone: otpPhone, principal: 'CUSTOMER', purpose: 'LOGIN', code: second.devCode },
      });
      assert.equal(current.status, 200);
    });

    it('enforces the resend cooldown', async () => {
      await requestCode('LOGIN');

      // Deliberately NOT clearing the cooldown: this is the assertion that the
      // limit is real, so the second request must hit the untouched window.
      const tooSoon = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: otpPhone, principal: 'CUSTOMER', purpose: 'LOGIN' },
      });

      assert.equal(tooSoon.status, 429);
      assert.equal(tooSoon.body.error.code, 'OTP_RESEND_TOO_SOON');
      assert.ok(tooSoon.body.error.details.retryAfterSeconds > 0);
    });

    it('never exposes the code hash', async () => {
      const stored = await prisma.otpChallenge.findFirst({
        where: { identifier: otpPhone },
        orderBy: { createdAt: 'desc' },
      });

      assert.ok(stored.codeHash.startsWith('$argon2id$'), 'codes must be Argon2id-hashed');
    });

    it('refuses OTP signup for a driver', async () => {
      const driverPhone = `+9197${String(Date.now()).slice(-8)}`;

      const requested = await call('/auth/otp/request', {
        method: 'POST',
        body: { phone: driverPhone, principal: 'DRIVER', purpose: 'SIGNUP' },
      });
      assert.equal(requested.status, 202);

      const verified = await call('/auth/otp/verify', {
        method: 'POST',
        body: {
          phone: driverPhone,
          principal: 'DRIVER',
          purpose: 'SIGNUP',
          code: requested.body.data.devCode,
        },
      });

      // Driver accounts are created by an administrator (BR-301). A valid code
      // proves the number, but must not mint a driver identity.
      assert.equal(verified.status, 401);
      assert.equal(
        await prisma.user.count({ where: { phone: driverPhone } }),
        0,
        'no driver identity should have been created'
      );

      await prisma.otpChallenge.deleteMany({ where: { identifier: driverPhone } });
    });

    it('records device metadata but ignores a client-supplied trusted flag', async () => {
      const login = await call('/auth/login', {
        method: 'POST',
        body: {
          principal: 'CUSTOMER',
          phone,
          password,
          platform: 'ANDROID',
          appVersion: '1.4.2',
          deviceName: 'Pixel 8',
          isTrusted: true,
        },
      });

      const sessions = await call('/auth/sessions', {
        token: login.body.data.tokens.accessToken,
      });
      const current = sessions.body.data.sessions.find((session) => session.isCurrent);

      assert.equal(current.platform, 'ANDROID');
      assert.equal(current.appVersion, '1.4.2');
      assert.equal(current.deviceName, 'Pixel 8');
      // Trust must never be self-declared.
      assert.equal(current.isTrusted, false);
    });

    it('sets an absolute ceiling that rotation cannot extend', async () => {
      const login = await call('/auth/login', {
        method: 'POST',
        body: { principal: 'CUSTOMER', phone, password },
      });

      const sessions = await call('/auth/sessions', {
        token: login.body.data.tokens.accessToken,
      });
      const current = sessions.body.data.sessions.find((session) => session.isCurrent);
      const originalCeiling = current.absoluteExpiresAt;

      await call('/auth/refresh', {
        method: 'POST',
        body: { refreshToken: login.body.data.tokens.refreshToken },
      });

      const after = await prisma.userSession.findUnique({
        where: { id: current.id },
        select: { absoluteExpiresAt: true, expiresAt: true, rotationCounter: true },
      });

      assert.equal(after.rotationCounter, 1, 'rotation should have happened');
      assert.equal(
        after.absoluteExpiresAt.toISOString(),
        new Date(originalCeiling).toISOString(),
        'rotation must NOT extend the absolute ceiling'
      );
      assert.ok(after.expiresAt <= after.absoluteExpiresAt, 'sliding expiry must stay under it');
    });
  }
);
