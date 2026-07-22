import { createLogger } from '../../../shared/logger/index.js';
import * as outboxRepository from '../repositories/outbox.repository.js';

const log = createLogger({ module: 'platform.outbox' });

/**
 * Recording intent to do something outside this transaction (ADR-012, BR-1402).
 *
 * `publish` takes a transaction client as its FIRST argument and there is no
 * overload that does not. Writing an outbox row on its own connection would
 * quietly reintroduce the two failures the pattern exists to prevent:
 *
 *   order saved, notification lost   - the commit succeeded, the send did not
 *   notification sent, order lost    - the send succeeded, the commit did not
 *
 * There is no drainer yet. That is deliberate and not a stub: docs/09 §16 warns
 * that "event producers must write outbox events from P1c onward, even before
 * this module exists. Retrofitting event emission is far harder than
 * retrofitting a consumer." Rows accumulate; tests assert them.
 */

/**
 * @param {import('@prisma/client').Prisma.TransactionClient} tx REQUIRED.
 * @param {object} event
 * @param {string} event.aggregate    'order'
 * @param {string} event.aggregateId
 * @param {string} event.eventType    `domain.action`, past tense (docs/11 §3).
 * @param {object} event.payload      SELF-CONTAINED - see below.
 */
export const publish = async (tx, { aggregate, aggregateId, eventType, payload }) => {
  if (!tx?.outboxEvent) {
    throw new TypeError(
      'publish() requires a Prisma transaction client. An outbox row written outside ' +
        'the transaction that changed the state defeats the entire pattern (ADR-012).'
    );
  }

  const event = await outboxRepository.append(tx, {
    aggregate,
    aggregateId,
    eventType,
    payload,
  });

  log.debug({ eventType, aggregateId }, 'outbox event queued');

  return event;
};

/**
 * Publish several events atomically with the state change that caused them.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {Array<object>} events
 */
export const publishAll = async (tx, events) => {
  if (events.length === 0) return;

  if (!tx?.outboxEvent) {
    throw new TypeError('publishAll() requires a Prisma transaction client (ADR-012).');
  }

  await outboxRepository.appendMany(tx, events);

  log.debug({ count: events.length }, 'outbox events queued');
};

export const listForAggregate = outboxRepository.listForAggregate;
