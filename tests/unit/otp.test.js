import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateNumericCode } from '../../src/infrastructure/providers/otp/otp-provider.js';
import { otpRequestSchema, otpVerifySchema } from '../../src/modules/identity/identity.schema.js';

describe('OTP code generation', () => {
  it('produces exactly the requested number of digits', () => {
    for (const length of [4, 6, 8]) {
      const code = generateNumericCode(length);

      assert.equal(code.length, length);
      assert.match(code, /^\d+$/);
    }
  });

  it('preserves leading zeros', () => {
    // Generating an integer and padding is where this bug usually starts:
    // "047382" must stay six characters, not become 47382.
    const codes = Array.from({ length: 400 }, () => generateNumericCode(6));

    assert.ok(
      codes.some((code) => code.startsWith('0')),
      'no code began with 0 across 400 samples - leading zeros are being lost'
    );
    assert.ok(codes.every((code) => code.length === 6));
  });

  it('is not obviously biased across digits', () => {
    // Rejection sampling per digit should give a roughly uniform spread. A
    // modulo-biased generator skews low digits noticeably.
    const counts = new Array(10).fill(0);

    for (let i = 0; i < 3_000; i += 1) {
      for (const digit of generateNumericCode(6)) {
        counts[Number(digit)] += 1;
      }
    }

    const expected = 18_000 / 10;
    for (const [digit, count] of counts.entries()) {
      assert.ok(
        Math.abs(count - expected) < expected * 0.25,
        `digit ${digit} appeared ${count} times, expected around ${expected}`
      );
    }
  });

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateNumericCode(6)));

    // 200 draws from 1e6 should almost never collide; a constant or weakly
    // seeded generator would collapse this set.
    assert.ok(codes.size > 190, `only ${codes.size} distinct codes from 200 draws`);
  });
});

describe('OTP request schema', () => {
  const valid = { phone: '+919876543210', principal: 'CUSTOMER', purpose: 'LOGIN' };

  it('accepts a valid request', () => {
    assert.equal(otpRequestSchema.body.safeParse(valid).success, true);
  });

  it('rejects an ADMIN principal', () => {
    // Administrators authenticate with a password and MFA, not an SMS code.
    assert.equal(otpRequestSchema.body.safeParse({ ...valid, principal: 'ADMIN' }).success, false);
  });

  it('rejects a purpose that is not publicly requestable', () => {
    // PASSWORD_RESET and PHONE_CHANGE have no implemented flow; exposing them
    // would issue codes for an operation nothing verifies.
    for (const purpose of ['PASSWORD_RESET', 'PHONE_CHANGE', 'EMAIL_VERIFICATION']) {
      assert.equal(
        otpRequestSchema.body.safeParse({ ...valid, purpose }).success,
        false,
        `${purpose} should not be publicly requestable`
      );
    }
  });

  it('rejects a non-Indian number', () => {
    assert.equal(
      otpRequestSchema.body.safeParse({ ...valid, phone: '+14155552671' }).success,
      false
    );
  });
});

describe('OTP verify schema', () => {
  const valid = {
    phone: '+919876543210',
    principal: 'CUSTOMER',
    purpose: 'LOGIN',
    code: '047382',
  };

  it('accepts a valid verification', () => {
    assert.equal(otpVerifySchema.body.safeParse(valid).success, true);
  });

  it('accepts a code with leading zeros as a string', () => {
    const result = otpVerifySchema.body.safeParse({ ...valid, code: '000001' });

    assert.equal(result.success, true);
    assert.equal(result.data.code, '000001');
  });

  it('rejects a non-numeric code', () => {
    assert.equal(otpVerifySchema.body.safeParse({ ...valid, code: 'abc123' }).success, false);
  });

  it('rejects an over-long code', () => {
    // Unbounded input feeds straight into Argon2, whose cost scales with length.
    assert.equal(
      otpVerifySchema.body.safeParse({ ...valid, code: '1'.repeat(500) }).success,
      false
    );
  });

  it('rejects a missing code', () => {
    const { code: _omitted, ...withoutCode } = valid;

    assert.equal(otpVerifySchema.body.safeParse(withoutCode).success, false);
  });

  it('does not accept a client-supplied trusted flag', () => {
    const result = otpVerifySchema.body.safeParse({ ...valid, isTrusted: true });

    // Zod strips unknown keys by default, so the flag must not survive parsing.
    assert.equal(result.success, true);
    assert.equal(result.data.isTrusted, undefined);
  });
});
