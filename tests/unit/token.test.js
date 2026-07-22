import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import jwt from 'jsonwebtoken';

import {
  hashRefreshToken,
  refreshTokenExpiryDate,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../../src/modules/identity/services/token.service.js';
import { durationToSeconds } from '../../src/shared/utils/duration.js';

const claims = {
  userId: '01984f2c-8a3b-7c1d-9e4f-2a6b8c0d1e3f',
  principal: 'CUSTOMER',
  sessionId: '01984f2c-8a3b-7c1d-9e4f-2a6b8c0d1e40',
  roles: ['CUSTOMER'],
  permissions: ['user.read.self'],
};

describe('token service', () => {
  it('round-trips an access token with its authorisation claims', () => {
    const payload = verifyAccessToken(signAccessToken(claims));

    assert.equal(payload.sub, claims.userId);
    assert.equal(payload.principal, 'CUSTOMER');
    assert.equal(payload.sid, claims.sessionId);
    assert.deepEqual(payload.permissions, ['user.read.self']);
    assert.equal(payload.typ, 'access');
  });

  it('keeps the refresh token free of authorisation data', () => {
    const payload = verifyRefreshToken(signRefreshToken(claims));

    // A long-lived token should age as little data as possible: roles baked in
    // 30 days ago would be badly stale.
    assert.equal(payload.roles, undefined);
    assert.equal(payload.permissions, undefined);
    assert.equal(payload.sid, claims.sessionId);
  });

  it('refuses an access token presented as a refresh token', () => {
    assert.throws(() => verifyRefreshToken(signAccessToken(claims)), {
      code: 'TOKEN_INVALID',
    });
  });

  it('refuses a refresh token presented as an access token', () => {
    assert.throws(() => verifyAccessToken(signRefreshToken(claims)), {
      code: 'TOKEN_INVALID',
    });
  });

  it('rejects a token signed with the wrong secret', () => {
    const forged = jwt.sign({ typ: 'access', sub: claims.userId }, 'a-different-secret-entirely', {
      algorithm: 'HS256',
      issuer: 'diesel-for-you',
    });

    assert.throws(() => verifyAccessToken(forged), { code: 'TOKEN_INVALID' });
  });

  it('rejects an expired token with a distinct code', () => {
    const expired = jwt.sign(
      { typ: 'access', sid: claims.sessionId },
      process.env.JWT_ACCESS_SECRET,
      {
        algorithm: 'HS256',
        subject: claims.userId,
        issuer: 'diesel-for-you',
        expiresIn: '-1s',
      }
    );

    // Distinct from TOKEN_INVALID so a client knows to refresh rather than
    // log the user out.
    assert.throws(() => verifyAccessToken(expired), { code: 'TOKEN_EXPIRED' });
  });

  it('rejects the "none" algorithm', () => {
    // Classic JWT attack: strip the signature and claim the token is unsigned.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: claims.userId, typ: 'access' })).toString(
      'base64url'
    );

    assert.throws(() => verifyAccessToken(`${header}.${body}.`), { code: 'TOKEN_INVALID' });
  });

  it('rejects a token issued by someone else', () => {
    const foreign = jwt.sign({ typ: 'access' }, process.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: claims.userId,
      issuer: 'some-other-service',
    });

    assert.throws(() => verifyAccessToken(foreign), { code: 'TOKEN_INVALID' });
  });

  it('hashes refresh tokens deterministically and irreversibly', () => {
    const token = signRefreshToken(claims);
    const hash = hashRefreshToken(token);

    assert.equal(hash, hashRefreshToken(token), 'same token must hash identically');
    assert.equal(hash.length, 64, 'sha-256 hex');
    assert.ok(!hash.includes(token), 'hash must not embed the token');
    assert.notEqual(hash, hashRefreshToken(`${token}x`));
  });

  it('parses every duration form the env schema allows', () => {
    assert.equal(durationToSeconds('30s'), 30);
    assert.equal(durationToSeconds('15m'), 900);
    assert.equal(durationToSeconds('2h'), 7_200);
    assert.equal(durationToSeconds('30d'), 2_592_000);
    assert.equal(durationToSeconds('3600'), 3_600, 'bare seconds');
  });

  it('derives refresh expiry from configuration', () => {
    const from = new Date('2026-07-20T00:00:00.000Z');
    const expiry = refreshTokenExpiryDate(from);

    // Default JWT_REFRESH_EXPIRES_IN is 30d.
    assert.equal(expiry.toISOString(), '2026-08-19T00:00:00.000Z');
  });
});
