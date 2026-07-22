import { createHash, randomBytes, randomUUID } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { env } from '../../../config/env.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { UnauthorizedError } from '../../../shared/errors/index.js';
import { durationFromNow } from '../../../shared/utils/duration.js';

/**
 * JWT issuing and verification.
 *
 * Two token types, two secrets:
 *
 *   ACCESS   short-lived, sent on every request, carries the caller's roles and
 *            permissions so authorisation needs no database round trip.
 *   REFRESH  long-lived, sent only to /auth/refresh, carries almost nothing.
 *
 * Separate secrets mean an access token cannot be replayed as a refresh token
 * even if the payload were forged; the `typ` claim is a second, independent
 * check on the same thing. Belt and braces, because confusing the two is a
 * total compromise.
 */

const TOKEN_TYPE = Object.freeze({ ACCESS: 'access', REFRESH: 'refresh' });

const ISSUER = 'diesel-for-you';
const ALGORITHM = 'HS256';

/**
 * Embedding roles and permissions in the access token is a deliberate
 * trade-off: authorisation costs zero queries, but a permission or status
 * change only takes effect when the access token expires (default 15 minutes).
 *
 * This matches BR-125, which re-checks account status on REFRESH rather than on
 * every request. Anything needing immediate effect - blocking an account
 * mid-incident - must also revoke the user's sessions, which `logout-all` and
 * the admin revoke path both do.
 */
export const signAccessToken = ({ userId, principal, sessionId, roles, permissions }) =>
  jwt.sign(
    {
      typ: TOKEN_TYPE.ACCESS,
      principal,
      sid: sessionId,
      roles,
      permissions,
    },
    env.JWT_ACCESS_SECRET,
    {
      algorithm: ALGORITHM,
      subject: userId,
      issuer: ISSUER,
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
      jwtid: randomUUID(),
    }
  );

/**
 * The refresh token carries only what is needed to find its session. No roles,
 * no permissions - it is long-lived, so it should age as little data as
 * possible.
 *
 * The random `jti` is what makes each rotation a distinct token even when
 * issued in the same second for the same session.
 */
export const signRefreshToken = ({ userId, sessionId }) =>
  jwt.sign({ typ: TOKEN_TYPE.REFRESH, sid: sessionId }, env.JWT_REFRESH_SECRET, {
    algorithm: ALGORITHM,
    subject: userId,
    issuer: ISSUER,
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
    jwtid: randomBytes(16).toString('hex'),
  });

const verify = (token, secret, expectedType) => {
  let payload;

  try {
    payload = jwt.verify(token, secret, { algorithms: [ALGORITHM], issuer: ISSUER });
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      throw new UnauthorizedError('Token has expired', { code: ERROR_CODES.TOKEN_EXPIRED });
    }
    // Signature failure, malformed token, wrong issuer. All are "invalid" to
    // the caller: distinguishing them tells an attacker which part to fix.
    throw new UnauthorizedError('Token is invalid', { code: ERROR_CODES.TOKEN_INVALID });
  }

  if (payload.typ !== expectedType) {
    throw new UnauthorizedError('Token is not valid for this operation', {
      code: ERROR_CODES.TOKEN_WRONG_TYPE,
    });
  }

  return payload;
};

export const verifyAccessToken = (token) => verify(token, env.JWT_ACCESS_SECRET, TOKEN_TYPE.ACCESS);

export const verifyRefreshToken = (token) =>
  verify(token, env.JWT_REFRESH_SECRET, TOKEN_TYPE.REFRESH);

/**
 * The stored form of a refresh token.
 *
 * SHA-256, not Argon2. A refresh token is 256 bits of server-generated
 * entropy inside a signed JWT, not a low-entropy human secret, so there is
 * nothing to brute-force and a deliberately slow KDF would only add latency to
 * every refresh. What matters is that the database never holds a usable
 * credential (BR-121).
 */
export const hashRefreshToken = (token) => createHash('sha256').update(token).digest('hex');

/**
 * Expiry of the SLIDING refresh window, recomputed on every rotation.
 *
 * Stored on the session so expiry can be enforced by a database query - a
 * revoked or expired session must be rejectable without decoding a token.
 */
export const refreshTokenExpiryDate = (from = new Date()) =>
  durationFromNow(env.JWT_REFRESH_EXPIRES_IN, from);

/**
 * The session's hard ceiling. Computed ONCE at login and never recomputed;
 * `rotateSession` must not call this.
 */
export const sessionAbsoluteExpiryDate = (from = new Date()) =>
  durationFromNow(env.SESSION_ABSOLUTE_LIFETIME, from);

export { TOKEN_TYPE };
