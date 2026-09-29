import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  changePasswordSchema,
  loginSchema,
  passwordResetSchema,
  refreshSchema,
  registerSchema,
  sessionIdSchema,
  updateMeSchema,
} from '../../src/modules/identity/identity.schema.js';

const parse = (schema, value) => schema.safeParse(value);

describe('register schema', () => {
  const valid = {
    phone: '+919876543210',
    code: '123456',
    password: 'a-sufficiently-long-password',
  };

  it('accepts mobile + SIGNUP code + password', () => {
    assert.equal(parse(registerSchema.body, valid).success, true);
  });

  it('accepts an optional email and lowercases it', () => {
    const result = parse(registerSchema.body, { ...valid, email: '  Asha@Example.COM ' });

    assert.equal(result.success, true);
    assert.equal(result.data.email, 'asha@example.com');
  });

  it('requires the mobile number', () => {
    // Every account must be reachable by mobile + OTP, so email-only sign-up is gone.
    const { phone: _phone, ...withoutPhone } = valid;
    const result = parse(registerSchema.body, { ...withoutPhone, email: 'a@b.com' });

    assert.equal(result.success, false);
  });

  it('requires the SIGNUP code', () => {
    // Verification-first: an unproven number must never be attached to an account.
    const { code: _code, ...withoutCode } = valid;

    assert.equal(parse(registerSchema.body, withoutCode).success, false);
  });

  it('rejects a non-Indian number', () => {
    // Phase 1 is India-only (BR-115), which also blunts SMS-pumping fraud.
    assert.equal(parse(registerSchema.body, { ...valid, phone: '+14155552671' }).success, false);
  });

  it('rejects an Indian number starting below 6', () => {
    assert.equal(parse(registerSchema.body, { ...valid, phone: '+915876543210' }).success, false);
  });

  it('rejects a short password', () => {
    assert.equal(parse(registerSchema.body, { ...valid, password: 'short' }).success, false);
  });

  it('caps password length to bound argon2 cost', () => {
    // Unbounded input is a cheap way to burn server CPU, since hashing cost
    // scales with length.
    const result = parse(registerSchema.body, { ...valid, password: 'x'.repeat(129) });

    assert.equal(result.success, false);
  });
});

describe('password reset schema', () => {
  const valid = {
    phone: '+919876543210',
    principal: 'DRIVER',
    code: '123456',
    newPassword: 'a-sufficiently-long-password',
  };

  it('accepts a valid reset for a customer or driver', () => {
    assert.equal(parse(passwordResetSchema.body, valid).success, true);
    assert.equal(
      parse(passwordResetSchema.body, { ...valid, principal: 'CUSTOMER' }).success,
      true
    );
  });

  it('rejects an ADMIN principal', () => {
    assert.equal(parse(passwordResetSchema.body, { ...valid, principal: 'ADMIN' }).success, false);
  });

  it('applies the password rules to the new password', () => {
    assert.equal(
      parse(passwordResetSchema.body, { ...valid, newPassword: 'short' }).success,
      false
    );
  });
});

describe('change password schema', () => {
  it('allows omitting the current password (first password on an OTP-only account)', () => {
    const result = parse(changePasswordSchema.body, {
      newPassword: 'a-sufficiently-long-password',
    });

    assert.equal(result.success, true);
  });

  it('rejects a short new password', () => {
    assert.equal(parse(changePasswordSchema.body, { newPassword: 'short' }).success, false);
  });
});

describe('update me schema', () => {
  it('accepts an email and null to remove it', () => {
    assert.equal(parse(updateMeSchema.body, { email: 'a@b.com' }).success, true);
    assert.equal(parse(updateMeSchema.body, { email: null }).success, true);
  });

  it('rejects an invalid email', () => {
    assert.equal(parse(updateMeSchema.body, { email: 'not-an-email' }).success, false);
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
