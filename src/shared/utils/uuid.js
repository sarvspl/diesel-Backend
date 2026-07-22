import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 - a time-ordered UUID (RFC 9562).
 *
 * Node's built-in `crypto.randomUUID()` only produces v4, whose randomness
 * scatters B-tree inserts and bloats indexes as tables grow. v7 puts a
 * millisecond timestamp in the leading 48 bits, so generated values sort by
 * creation time and inserts append to the right-hand edge of the index
 * (ADR-005).
 *
 * Prisma applies `@default(uuid(7))` when no id is supplied. This exists for
 * the cases where the id must be known BEFORE the insert - a session id has to
 * be embedded in the refresh token that the same row stores the hash of.
 *
 * Layout:
 *   bytes 0-5   unix timestamp, milliseconds, big-endian
 *   byte  6     version (7) in the high nibble
 *   byte  8     variant (10xx) in the high bits
 *   remainder   random
 *
 * @returns {string} e.g. "01984f2c-8a3b-7c1d-9e4f-2a6b8c0d1e3f"
 */
export const uuidv7 = () => {
  const bytes = randomBytes(16);
  const milliseconds = BigInt(Date.now());

  bytes[0] = Number((milliseconds >> 40n) & 0xffn);
  bytes[1] = Number((milliseconds >> 32n) & 0xffn);
  bytes[2] = Number((milliseconds >> 24n) & 0xffn);
  bytes[3] = Number((milliseconds >> 16n) & 0xffn);
  bytes[4] = Number((milliseconds >> 8n) & 0xffn);
  bytes[5] = Number(milliseconds & 0xffn);

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
};
