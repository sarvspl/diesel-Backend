import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  loginSchema,
  refreshSchema,
  registerSchema,
  sessionIdSchema,
} from '../../src/modules/identity/identity.schema.js';

const parse = (schema, value) => schema.safeParse(value);

describe('register schema', () => {
  it('accepts a phone registration', () => {
    const result = parse(registerSchema.body, {
      phone: '+919876543210',
      password: 'a-sufficiently-long-password',
    });

    assert.equal(result.success, true);
  });

  it('accepts an email registration and lowercases it', () => {
    const result = parse(registerSchema.body, {
      email: '  Admin@Example.COM ',
      password: 'a-sufficiently-long-password',
    });

    assert.equal(result.success, true);
    assert.equal(result.data.email, 'admin@example.com');
  });

  it('rejects both phone and email together', () => {
    const result = parse(registerSchema.body, {
      phone: '+919876543210',
      email: 'a@b.com',
      password: 'a-sufficiently-long-password',
    });

    assert.equal(result.success, false);
  });

  it('rejects neither phone nor email', () => {
    const result = parse(registerSchema.body, { password: 'a-sufficiently-long-password' });

    assert.equal(result.success, false);
  });

  it('rejects a non-Indian number', () => {
    // Phase 1 is India-only (BR-115), which also blunts SMS-pumping fraud.
    const result = parse(registerSchema.body, {
      phone: '+14155552671',
      password: 'a-sufficiently-long-password',
    });

    assert.equal(result.success, false);
  });

  it('rejects an Indian number starting below 6', () => {
    const result = parse(registerSchema.body, {
      phone: '+915876543210',
      password: 'a-sufficiently-long-password',
    });

    assert.equal(result.success, false);
  });

  it('rejects a short password', () => {
    const result = parse(registerSchema.body, { phone: '+919876543210', password: 'short' });

    assert.equal(result.success, false);
  });

  it('caps password length to bound argon2 cost', () => {
    // Unbounded input is a cheap way to burn server CPU, since hashing cost
    // scales with length.
    const result = parse(registerSchema.body, {
      phone: '+919876543210',
      password: 'x'.repeat(129),
    });

    assert.equal(result.success, false);
  });
});

describe('login schema', () => {
  it('requires an explicit principal', () => {
    // The same phone may be a customer and a driver (BR-104), so the server
    // cannot infer which account is meant.
    const result = parse(loginSchema.body, {
      phone: '+919876543210',
      password: 'whatever',
    });

    assert.equal(result.success, false);
  });

  it('accepts a valid login', () => {
    const result = parse(loginSchema.body, {
      principal: 'DRIVER',
      phone: '+919876543210',
      password: 'whatever',
    });

    assert.equal(result.success, true);
  });

  it('rejects an unknown principal', () => {
    const result = parse(loginSchema.body, {
      principal: 'SUPERUSER',
      phone: '+919876543210',
      password: 'whatever',
    });

    assert.equal(result.success, false);
  });

  it('does not impose the registration length rule on login', () => {
    // Rejecting a short password at login would reveal that it fails current
    // policy, which is information about the account.
    const result = parse(loginSchema.body, {
      principal: 'ADMIN',
      email: 'a@b.com',
      password: 'old',
    });

    assert.equal(result.success, true);
  });
});

describe('refresh and session schemas', () => {
  it('requires a refresh token', () => {
    assert.equal(parse(refreshSchema.body, {}).success, false);
    assert.equal(parse(refreshSchema.body, { refreshToken: 'x' }).success, true);
  });

  it('requires a UUID session id', () => {
    assert.equal(parse(sessionIdSchema.params, { id: 'not-a-uuid' }).success, false);
    assert.equal(
      parse(sessionIdSchema.params, { id: '01984f2c-8a3b-7c1d-9e4f-2a6b8c0d1e3f' }).success,
      true
    );
  });
});
