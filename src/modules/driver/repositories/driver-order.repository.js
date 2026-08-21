import { prisma } from '../../../infrastructure/database/prisma.js';
import { RESERVATION_STATUS } from '../../../shared/constants/order.js';

/**
 * Orders visible to a driver.
 *
 * HOW AN ORDER REACHES A DRIVER, since the order table has no driver column:
 *
 *   order --(FuelReservation.vehicleId)--> vehicle
 *   vehicle --(VehicleAssignment, releasedAt: null)--> driverProfile
 *
 * The reservation IS the assignment as far as fulfilment is concerned: fuel
 * held on a tanker is what makes that tanker responsible for the order. Adding
 * a `driverId` column to orders would create a second source of truth that can
 * disagree with the reservation, and the one that disagrees is the one that
 * sends two drivers to the same site.
 */

/** Statuses a driver is actively working. */
const ACTIVE_STATUSES = ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'DISPENSING'];

/** Statuses that are done, for the history view. */
const COMPLETED_STATUSES = [
  'DELIVERED',
  'PARTIALLY_DELIVERED',
  'DELIVERY_FAILED',
  'CLOSED',
];

const ORDER_FIELDS = {
  id: true,
  orderNumber: true,
  status: true,
  paymentStatus: true,
  paymentMode: true,
  quantity: true,
  deliveredQuantity: true,
  totalAmount: true,
  finalTotalAmount: true,
  city: true,
  deliveryInstructions: true,
  customerSnapshot: true,
  addressSnapshot: true,
  productSnapshot: true,
  placedAt: true,
  statusChangedAt: true,
};

/** The vehicle this driver currently holds, if any. */
export const findActiveVehicleIdForDriver = async (driverProfileId) => {
  const assignment = await prisma.vehicleAssignment.findFirst({
    where: { driverProfileId, releasedAt: null },
    select: { vehicleId: true },
  });

  return assignment?.vehicleId ?? null;
};

/**
 * Orders held on this driver's vehicle.
 *
 * Scoped through the vehicle rather than taking a vehicleId parameter, so a
 * driver cannot ask about a tanker that is not theirs (BR-225).
 */
export const listOrdersForDriver = async ({ driverProfileId, scope = 'ACTIVE', limit = 25 }) => {
  const vehicleId = await findActiveVehicleIdForDriver(driverProfileId);

  if (!vehicleId) return { orders: [], vehicleId: null };

  const statuses = scope === 'COMPLETED' ? COMPLETED_STATUSES : ACTIVE_STATUSES;

  const orders = await prisma.order.findMany({
    where: {
      status: { in: statuses },
      reservations: {
        some: {
          vehicleId,
          // A released reservation means the order moved to another tanker.
          // Completed deliveries keep their CONSUMED reservation, which is
          // what makes history work.
          status:
            scope === 'COMPLETED'
              ? { in: [RESERVATION_STATUS.CONSUMED, RESERVATION_STATUS.HELD] }
              : RESERVATION_STATUS.HELD,
        },
      },
    },
    select: ORDER_FIELDS,
    // Oldest first for active work: a queue is only fair if it is a queue.
    // Newest first for history, which is browsed rather than worked.
    orderBy: scope === 'COMPLETED' ? { statusChangedAt: 'desc' } : { placedAt: 'asc' },
    take: limit,
  });

  return { orders, vehicleId };
};

/**
 * One order, but only if it is genuinely on this driver's vehicle.
 *
 * Returns null rather than throwing a permission error, so the caller answers
 * 404 for an order that exists but is not theirs. A 403 would confirm the
 * order exists, which is information a driver has no business getting.
 */
export const findOrderForDriver = async ({ driverProfileId, orderId }) => {
  const vehicleId = await findActiveVehicleIdForDriver(driverProfileId);

  if (!vehicleId) return null;

  return prisma.order.findFirst({
    where: {
      id: orderId,
      reservations: { some: { vehicleId } },
    },
    select: {
      ...ORDER_FIELDS,
      reservations: {
        where: { vehicleId },
        select: {
          id: true,
          status: true,
          quantity: true,
          vehicleId: true,
          expiresAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      statusEvents: {
        select: {
          fromStatus: true,
          toStatus: true,
          actorKind: true,
          reason: true,
          occurredAt: true,
        },
        orderBy: { occurredAt: 'asc' },
      },
    },
  });
};

/** BR-310 / BR-307: is this driver holding work right now? */
export const countActiveOrdersForDriver = async (driverProfileId) => {
  const vehicleId = await findActiveVehicleIdForDriver(driverProfileId);

  if (!vehicleId) return 0;

  return prisma.order.count({
    where: {
      status: { in: ACTIVE_STATUSES },
      reservations: { some: { vehicleId, status: RESERVATION_STATUS.HELD } },
    },
  });
};

/** Delivery meter readings for an order, oldest first. */
export const listDeliveryReadings = async (orderId) =>
  prisma.meterReading.findMany({
    where: { orderId },
    select: {
      id: true,
      readingType: true,
      totalizer: true,
      stockLitres: true,
      source: true,
      grossQuantity: true,
      netQuantity: true,
      photoKey: true,
      capturedAt: true,
      notes: true,
    },
    orderBy: { capturedAt: 'asc' },
  });

export { ACTIVE_STATUSES, COMPLETED_STATUSES };
