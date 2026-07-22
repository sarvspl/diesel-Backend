import { prisma } from '../../../infrastructure/database/prisma.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { NotFoundError } from '../../../shared/errors/index.js';
import * as reservationService from '../../dispatch/services/reservation.service.js';
import * as orderRepository from '../repositories/order.repository.js';
import { allowedTransitionsFrom } from '../state-machine.js';

import {
  toAdminOrder,
  toAdminTimelineEntry,
  toOrderSummary,
  toPublicOrder,
  toPublicTimelineEntry,
} from './order-view.js';

/**
 * Reads.
 *
 * Every customer-facing query in this file goes through
 * `orderRepository.findForUser` / `listForUser`, which scope at the data-access
 * layer rather than trusting a controller check (docs/11 §7.3: "a missing
 * controller check is one forgotten line from a data breach").
 *
 * Corporate scope is derived from the caller's ACTIVE memberships, never from a
 * request parameter (BR-225). A member cannot read another company's orders by
 * changing an id, because no query here accepts a company id from the client.
 */

/** The caller's active corporate memberships. Derived from the token's user. */
const corporateScopeFor = async (userId) => {
  const memberships = await prisma.corporateMember.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { corporateAccountId: true },
  });

  return memberships.map((membership) => membership.corporateAccountId);
};

export const getOwnOrder = async ({ orderId, userId }) => {
  const corporateAccountIds = await corporateScopeFor(userId);
  const order = await orderRepository.findForUser({ id: orderId, userId, corporateAccountIds });

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  return toPublicOrder(order);
};

export const listOwnOrders = async ({ userId, status, limit = 20, cursor }) => {
  const corporateAccountIds = await corporateScopeFor(userId);

  const rows = await orderRepository.listForUser({
    userId,
    corporateAccountIds,
    status,
    // One extra row to discover whether another page exists, without a count
    // query (ADR-014: total counts need a separate, deliberate query).
    limit: limit + 1,
    cursor,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    orders: page.map(toOrderSummary),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

/**
 * The customer's order timeline (docs/04 §3, §26).
 *
 * Ownership is verified by loading the order through the scoped read FIRST.
 * Querying events by order id alone would expose any order's history to anyone
 * who guessed an id.
 */
export const getOwnOrderTimeline = async ({ orderId, userId }) => {
  const corporateAccountIds = await corporateScopeFor(userId);
  const order = await orderRepository.findForUser({ id: orderId, userId, corporateAccountIds });

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  const events = await orderRepository.listStatusEvents({ orderId });

  return {
    orderId,
    orderNumber: order.orderNumber,
    currentStatus: order.status,
    timeline: events.map(toPublicTimelineEntry),
  };
};

// --- Administrative ---------------------------------------------------------

export const listAllOrders = async ({ limit = 20, cursor, ...filters }) => {
  const rows = await orderRepository.listAll({ ...filters, limit: limit + 1, cursor });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return {
    orders: page.map(toOrderSummary),
    pagination: { nextCursor: hasMore ? page.at(-1).id : null, hasMore },
  };
};

/**
 * The support investigation view (docs/04 §26).
 *
 * Everything at once, because the alternative is an agent making four calls
 * while a customer waits: the order, its full timeline including SYSTEM
 * transitions, its reservations, and what may legally happen next.
 */
export const getOrderForAdmin = async (orderId) => {
  const order = await orderRepository.findById(orderId);

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  const [events, reservations] = await Promise.all([
    orderRepository.listStatusEvents({ orderId }),
    reservationService.listForOrder(orderId),
  ]);

  return {
    order: toAdminOrder(order),
    timeline: events.map(toAdminTimelineEntry),
    reservations: reservations.map(reservationService.toAdminReservation),
    /// What an operator may do from here, straight from the transition table.
    /// The admin UI renders buttons from this rather than hardcoding a list
    /// that drifts from the machine.
    allowedTransitions: allowedTransitionsFrom(order.status, 'ADMIN'),
  };
};

export const getAdminOrderTimeline = async (orderId) => {
  const order = await orderRepository.findById(orderId);

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  const events = await orderRepository.listStatusEvents({ orderId });

  return {
    orderId,
    orderNumber: order.orderNumber,
    currentStatus: order.status,
    timeline: events.map(toAdminTimelineEntry),
  };
};
