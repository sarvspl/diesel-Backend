import { createHash } from 'node:crypto';

import { env } from '../../../config/env.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { IDEMPOTENCY_STATE } from '../../../shared/constants/order.js';
import { ConflictError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as idempotencyRepository from '../repositories/idempotency.repository.js';

const log = createLogger({ module: 'platform.idempotency' });

/**
 * Idempotent execution of a mutating operation (BR-803, ADR-013, docs/10 §8).
 *
 * WHY THIS IS NOT OPTIONAL: mobile clients retry on timeout by design, users
 * double-tap, gateways replay webhooks and the driver app replays an offline
 * outbox. Duplicates are guaranteed, not possible. Without this, the guaranteed
 * outcome is two orders, two fuel reservations and two charges.
 *
 * The four cases (docs/10 §8.2):
 *
 *   key unseen            -> run it, store the result
 *   key seen, same body   -> return the STORED response, do not re-execute
 *   key seen, other body  -> 409, the key is being reused for another operation
 *   key seen, in progress -> 409 with a retry hint
 */

/**
 * A stable fingerprint of the request body.
 *
 * Keys are sorted recursively before hashing, so `{a:1,b:2}` and `{b:2,a:1}`
 * are the same request. Without that, a client that serialises its JSON in a
 * different key order on retry would be told its own retry is a different
 * operation - which is the failure this whole mechanism exists to avoid.
 */
const canonicalise = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalise(value[key])])
  );
};

export const fingerprint = (body) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalise(body ?? {})))
    .digest('hex');

/**
 * Run `operation` at most once for this (user, endpoint, key).
 *
 * @param {object} params
 * @param {string} params.key        The client's Idempotency-Key.
 * @param {string} params.userId
 * @param {string} params.endpoint   'POST /orders'.
 * @param {unknown} params.body      Hashed to detect key reuse.
 * @param {() => Promise<{ status: number, body: unknown, resourceId?: string }>} params.operation
 * @returns {Promise<{ status: number, body: unknown, replayed: boolean }>}
 */
export const runOnce = async ({ key, userId, endpoint, body, operation }) => {
  const requestHash = fingerprint(body);
  const expiresAt = new Date(Date.now() + env.IDEMPOTENCY_TTL_HOURS * 3_600_000);

  const { claimed, record } = await idempotencyRepository.claim({
    key,
    userId,
    endpoint,
    requestHash,
    expiresAt,
  });

  if (!claimed) {
    // Reuse for a DIFFERENT operation. Checked before the in-progress case:
    // it is a client bug either way, and this is the more specific diagnosis.
    if (record.requestHash !== requestHash) {
      log.warn({ userId, endpoint }, 'idempotency key reused with a different request');

      throw new ConflictError('This idempotency key was already used for a different request', {
        code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      });
    }

    if (record.state === IDEMPOTENCY_STATE.IN_PROGRESS) {
      throw new ConflictError('That request is still being processed. Retry shortly.', {
        code: ERROR_CODES.IDEMPOTENCY_REQUEST_IN_PROGRESS,
        details: { retryAfterSeconds: 2 },
      });
    }

    log.info({ userId, endpoint, resourceId: record.resourceId }, 'idempotent replay');

    /**
     * The ORIGINAL status code is replayed, not a 200.
     *
     * docs/10 §8.2 says "return the stored response" without naming a status,
     * so this is a decision rather than a quotation: a client that branches on
     * 201 to read a Location header must behave identically on the retry it
     * was told to make, or the mechanism has changed the contract it exists to
     * preserve.
     */
    return { status: record.responseStatus, body: record.responseBody, replayed: true };
  }

  try {
    const result = await operation();

    await idempotencyRepository.complete({
      id: record.id,
      responseStatus: result.status,
      responseBody: result.body,
      resourceId: result.resourceId,
    });

    return { ...result, replayed: false };
  } catch (error) {
    // A client error is a real, reproducible answer: keep it, so a retry gets
    // the same 4xx rather than re-running the work.
    const isClientError =
      error?.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500;

    if (isClientError) {
      await idempotencyRepository.complete({
        id: record.id,
        responseStatus: error.statusCode,
        responseBody: {
          success: false,
          message: error.message,
          error: { code: error.code, details: error.details },
        },
      });
    } else {
      // A server error might be transient. Free the key so the same one can be
      // retried, which is exactly what the client has been told to do.
      await idempotencyRepository.release(record.id);
    }

    throw error;
  }
};
