import { sendCreated, sendSuccess } from '../../shared/utils/api-response.js';
import { toQuantityString, toMoneyString } from '../../shared/utils/money.js';

import * as driverOrderRepository from './repositories/driver-order.repository.js';
import * as deliveryService from './services/delivery.service.js';
import * as selfService from './services/driver-self.service.js';
import * as shiftService from './services/driver-shift.service.js';

/**
 * Thin HTTP layer. No business logic, no database access.
 *
 * Every handler resolves the driver from `req.auth.userId`. None of them
 * accepts a driver identifier, which is what makes cross-driver access
 * impossible rather than merely forbidden (BR-225).
 */

/**
 * The driver's view of an order.
 *
 * Deliberately NARROWER than the admin projection. A driver gets what they need
 * to complete the delivery — where, how much, who to ask for — and nothing
 * about pricing beyond the amount to collect for a cash order. Fleet capacity,
 * reservations on other vehicles and the customer's account history are none of
 * their business (docs/03 §3).
 */
const toDriverOrder = (order) => ({
  id: order.id,
  orderNumber: order.orderNumber,
  status: order.status,
  quantity: toQuantityString(order.quantity),
  deliveredQuantity:
    order.deliveredQuantity === null || order.deliveredQuantity === undefined
      ? null
      : toQuantityString(order.deliveredQuantity),
  product: order.productSnapshot ?? null,

  /** Cash on delivery is the only case a driver needs an amount at all. */
  paymentMode: order.paymentMode,
  amountToCollect:
    order.paymentMode === 'CASH_ON_DELIVERY'
      ? toMoneyString(order.finalTotalAmount ?? order.totalAmount)
      : null,

  customer: order.customerSnapshot
    ? { fullName: order.customerSnapshot.fullName, phone: order.customerSnapshot.phone }
    : null,

  address: order.addressSnapshot ?? null,
  deliveryInstructions: order.deliveryInstructions,

  placedAt: order.placedAt,
  statusChangedAt: order.statusChangedAt,
});

/** GET /api/v1/driver/me */
export const getMe = async (req, res) => {
  const result = await selfService.getSelf(req.auth.userId);

  return sendSuccess(res, { message: 'Driver profile retrieved', data: result });
};

/** PATCH /api/v1/driver/availability */
export const setAvailability = async (req, res) => {
  const driver = await selfService.setAvailability({
    userId: req.auth.userId,
    availability: req.validated.body.availability,
  });

  return sendSuccess(res, { message: 'Availability updated', data: { driver } });
};

/** GET /api/v1/driver/shifts/current */
export const getCurrentShift = async (req, res) => {
  const shift = await shiftService.getCurrentShift(req.auth.userId);

  return sendSuccess(res, { message: 'Current shift retrieved', data: { shift } });
};

/** POST /api/v1/driver/shifts/start */
export const startShift = async (req, res) => {
  const shift = await shiftService.startShift({
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendCreated(res, { message: 'Shift started', data: { shift } });
};

/** POST /api/v1/driver/shifts/end */
export const endShift = async (req, res) => {
  const shift = await shiftService.endShift({
    userId: req.auth.userId,
    ...req.validated.body,
  });

  return sendSuccess(res, { message: 'Shift ended', data: { shift } });
};

/** GET /api/v1/driver/orders */
export const listOrders = async (req, res) => {
  const driver = await selfService.resolveDriverProfile(req.auth.userId);

  const { orders, vehicleId } = await driverOrderRepository.listOrdersForDriver({
    driverProfileId: driver.id,
    ...req.validated.query,
  });

  return sendSuccess(res, {
    message: 'Orders retrieved',
    data: { orders: orders.map(toDriverOrder), vehicleId },
  });
};

/** GET /api/v1/driver/orders/:id */
export const getOrder = async (req, res) => {
  const driver = await selfService.resolveDriverProfile(req.auth.userId);

  const order = await driverOrderRepository.findOrderForDriver({
    driverProfileId: driver.id,
    orderId: req.validated.params.id,
  });

  if (!order) {
    // 404 rather than 403: a 403 would confirm the order exists.
    return sendSuccess(res, { statusCode: 404, message: 'Order not found', data: {} });
  }

  const readings = await driverOrderRepository.listDeliveryReadings(order.id);

  return sendSuccess(res, {
    message: 'Order retrieved',
    data: {
      order: toDriverOrder(order),
      timeline: order.statusEvents ?? [],
      reservation: order.reservations?.[0] ?? null,
      readings: readings.map((reading) => ({
        id: reading.id,
        readingType: reading.readingType,
        totalizer: toQuantityString(reading.totalizer),
        capturedAt: reading.capturedAt,
        hasPhoto: Boolean(reading.photoKey),
      })),
    },
  });
};

/** POST /api/v1/driver/orders/:id/start-trip */
export const startTrip = async (req, res) => {
  const order = await deliveryService.startTrip({
    userId: req.auth.userId,
    orderId: req.validated.params.id,
    requestId: req.id,
  });

  return sendSuccess(res, { message: 'Trip started', data: { order: toDriverOrder(order) } });
};

/** POST /api/v1/driver/orders/:id/arrive */
export const arrive = async (req, res) => {
  const order = await deliveryService.markArrived({
    userId: req.auth.userId,
    orderId: req.validated.params.id,
    ...req.validated.body,
    requestId: req.id,
  });

  return sendSuccess(res, { message: 'Arrival recorded', data: { order: toDriverOrder(order) } });
};

/** POST /api/v1/driver/orders/:id/start-dispensing */
export const startDispensing = async (req, res) => {
  const order = await deliveryService.startDispensing({
    userId: req.auth.userId,
    orderId: req.validated.params.id,
    ...req.validated.body,
    requestId: req.id,
  });

  return sendSuccess(res, {
    message: 'Dispensing started',
    data: { order: toDriverOrder(order) },
  });
};

/** POST /api/v1/driver/orders/:id/complete */
export const completeDelivery = async (req, res) => {
  const result = await deliveryService.completeDelivery({
    userId: req.auth.userId,
    orderId: req.validated.params.id,
    ...req.validated.body,
    requestId: req.id,
  });

  return sendSuccess(res, {
    // A replay is a success, not an error — that is the whole point of BR-914.
    message: result.replayed ? 'Delivery already recorded' : 'Delivery recorded',
    data: {
      order: toDriverOrder(result.order),
      replayed: result.replayed,
      /**
       * `String(...)` before the formatter, not `toQuantityString(number)`.
       *
       * The money helpers REFUSE a JS number by design — passing one is how
       * exact decimals silently become doubles. The computed quantity is a
       * number in the service, so it is stringified at this boundary.
       */
      deliveredQuantity:
        result.deliveredQuantity === undefined || result.deliveredQuantity === null
          ? null
          : toQuantityString(String(result.deliveredQuantity)),
      rollover: result.rollover ?? false,
    },
  });
};
