import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';

import { env } from '../../../config/env.js';
import { createLogger } from '../../../shared/logger/index.js';

const log = createLogger({ module: 'identity.password' });

/**
 * Password hashing.
 *
 * Argon2**id** specifically - the hybrid variant. Argon2i is weak against
 * time-memory trade-offs; Argon2d is weak against side channels. `id` is the
 * variant every current guideline recommends for password storage.
 *
 * Implementation note: `@node-rs/argon2` rather than the `argon2` package.
 * The latter compiles through node-gyp and has no prebuilt binary for
 * Node 25, so it fails to install on this toolchain. `@node-rs/argon2` ships
 * Node-API prebuilds, which are ABI-stable across Node releases. Same
 * algorithm, same output format.
 */
const options = {
  algorithm: Algorithm.Argon2id,
  memoryCost: env.ARGON2_MEMORY_COST_KIB,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
};

/**
 * A real hash of a throwaway value, used to burn the same CPU time when no
 * account matched. See `verifyPassword`.
 *
 * The PROMISE is cached rather than the resolved string: assigning it is
 * synchronous, so concurrent callers share one computation. Caching the
 * awaited value instead leaves a gap between the check and the assignment in
 * which several requests each start their own hash.
 */
let decoyHashPromise;

const getDecoyHash = () => {
  decoyHashPromise ??= argon2Hash('decoy-value-never-matches-any-real-password', options);
  return decoyHashPromise;
};

/**
 * @param {string} plaintext
 * @returns {Promise<string>} Encoded Argon2id hash, including its parameters.
 */
export const hashPassword = async (plaintext) => argon2Hash(plaintext, options);

/**
 * Verify a password against a stored hash.
 *
 * `storedHash` may be null - identities that authenticate only by OTP have no
 * password (BR-101). In that case a decoy verification still runs, so "this
 * account has no password" takes the same time as "this password is wrong".
 * Without it, response timing reveals which accounts exist and how they
 * authenticate.
 *
 * @param {string|null|undefined} storedHash
 * @param {string} plaintext
 * @returns {Promise<boolean>}
 */
export const verifyPassword = async (storedHash, plaintext) => {
  if (!storedHash) {
    await argon2Verify(await getDecoyHash(), plaintext).catch(() => false);
    return false;
  }

  try {
    return await argon2Verify(storedHash, plaintext);
  } catch (error) {
    // A malformed or truncated hash in the database. Never a reason to let the
    // login through, but it is a data-integrity problem worth surfacing.
    log.error({ err: error }, 'stored password hash could not be parsed');
    return false;
  }
};

/**
 * Equalise timing for a login against an identifier that does not exist.
 *
 * Called on the "no such user" branch so that branch costs the same as a real
 * verification (docs: prevent user enumeration).
 */
export const burnPasswordTiming = async (plaintext) => {
  await argon2Verify(await getDecoyHash(), plaintext).catch(() => false);
};
