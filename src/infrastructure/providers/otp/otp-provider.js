import { randomInt } from 'node:crypto';

/**
 * OtpProvider - the contract for delivering a one-time code to a person.
 *
 * The interface is owned by the platform, not by a vendor: it expresses what
 * the business needs (get this code to this recipient) rather than what any SDK
 * offers (ADR-011). That is what makes the vendor replaceable.
 *
 * Issuing, verifying, expiring and rate-limiting codes is the OTP SERVICE's
 * job. A provider only delivers. Keeping the split means swapping SMS vendors
 * cannot alter the security properties of the flow.
 *
 * @typedef {object} OtpDeliveryRequest
 * @property {string} identifier Destination: E.164 phone, or email.
 * @property {string} code       Plaintext code. NEVER logged or persisted.
 * @property {string} purpose    LOGIN | SIGNUP | PHONE_VERIFICATION | ...
 * @property {number} ttlSeconds Validity, for the message body.
 *
 * @typedef {object} OtpDeliveryResult
 * @property {boolean} delivered
 * @property {string}  provider
 * @property {string} [providerMessageId] For reconciling delivery receipts.
 *
 * @typedef {object} OtpProvider
 * @property {string} name
 * @property {(request: OtpDeliveryRequest) => Promise<OtpDeliveryResult>} send
 */

/**
 * Generate a numeric code of the given length.
 *
 * `randomInt` is a CSPRNG. `Math.random()` is seeded predictably and is not
 * acceptable for a value an attacker benefits from guessing.
 *
 * Drawing one digit at a time avoids the modulo bias that
 * `randomInt(0, 10 ** n)` would introduce on a range that is not a power of
 * two, and keeps leading zeros - "047382" is a valid six-digit code, whereas
 * generating an integer and padding is where that bug usually starts.
 *
 * @param {number} length
 * @returns {string}
 */
export const generateNumericCode = (length) => {
  let code = '';

  for (let index = 0; index < length; index += 1) {
    code += String(randomInt(0, 10));
  }

  return code;
};
