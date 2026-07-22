import '../helpers/env.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  burnPasswordTiming,
  hashPassword,
  verifyPassword,
} from '../../src/modules/identity/services/password.service.js';

describe('password service', () => {
  it('produces an argon2id hash, not argon2i or argon2d', () => {
    return hashPassword('correct horse battery staple').then((hash) => {
      // The variant matters: argon2i is weak to time-memory trade-offs and
      // argon2d to side channels. Only `id` is recommended for passwords.
      assert.ok(hash.startsWith('$argon2id$'), `unexpected variant: ${hash.slice(0, 12)}`);
    });
  });

  it('never stores the plaintext', async () => {
    const plaintext = 'correct horse battery staple';
    const hash = await hashPassword(plaintext);

    assert.ok(!hash.includes(plaintext));
  });

  it('salts: the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

    // Equal hashes would mean no salt, which makes rainbow tables viable.
    assert.notEqual(first, second);
    assert.ok(await verifyPassword(first, 'same'));
    assert.ok(await verifyPassword(second, 'same'));
  });

  it('verifies a correct password', async () => {
    const hash = await hashPassword('s3cure-enough-password');

    assert.equal(await verifyPassword(hash, 's3cure-enough-password'), true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cure-enough-password');

    assert.equal(await verifyPassword(hash, 's3cure-enough-passwore'), false);
  });

  it('returns false rather than throwing when no password is set', async () => {
    // OTP-only identities have a null hash (BR-101). This must not crash the
    // login path.
    assert.equal(await verifyPassword(null, 'anything'), false);
    assert.equal(await verifyPassword(undefined, 'anything'), false);
  });

  it('returns false rather than throwing on a corrupt stored hash', async () => {
    assert.equal(await verifyPassword('not-a-valid-argon2-hash', 'anything'), false);
  });

  it('burns comparable time for a non-existent account', async () => {
    const hash = await hashPassword('a-real-password');

    const measure = async (fn) => {
      const started = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const realVerify = await measure(() => verifyPassword(hash, 'wrong-password'));
    const decoyVerify = await measure(() => burnPasswordTiming('wrong-password'));

    // Both perform a full Argon2 verification, so the "no such user" branch
    // cannot be distinguished by response time. The bound is loose because
    // CI timing is noisy; the point is that the decoy is not near-instant.
    assert.ok(
      decoyVerify > realVerify * 0.25,
      `decoy ${decoyVerify.toFixed(1)}ms vs real ${realVerify.toFixed(1)}ms - decoy too fast`
    );
  });
});
