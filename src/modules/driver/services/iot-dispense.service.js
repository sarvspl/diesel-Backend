import { prisma } from '../../../infrastructure/database/prisma.js';
import {
  getIotDispenseProvider,
  IotDispenseError,
  requestRefFor,
} from '../../../infrastructure/providers/iot-dispense/index.js';
import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import { ORDER_STATUS, RESERVATION_STATUS } from '../../../shared/constants/order.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as driverOrderRepository from '../repositories/driver-order.repository.js';

import { resolveDriverProfile } from './driver-self.service.js';

const log = createLogger({ module: 'driver.iot-dispense' });

/**
 * Unlock the tanker's pump through the IoT dispense controller and hand the
 * driver the MPIN to key in.
 *
 * ONE AUTHORIZATION PER ORDER. Once the vendor has said AUTHORIZED, a repeat
 * request returns the stored MPIN instead of calling again: a second call
 * would unlock the pump for a second batch of litres.
 *
 * Allowed at ARRIVED (the normal moment, just before start-dispensing) and at
 * DISPENSING (to show the MPIN again). Never earlier: an unlocked pump on a
 * moving tanker is fuel with no customer.
 */

const ALLOWED_STATUSES = [ORDER_STATUS.ARRIVED, ORDER_STATUS.DISPENSING];

const toAuthorization = (row, reused) => ({
  id: row.id,
  status: row.status,
  iotTransactionId: row.iotTransactionId,
  mpin: row.mpin,
  authorizedLitres: row.authorizedLitres,
  deviceId: row.deviceId,
  createdAt: row.createdAt,
  reused,
});

export const authorizeDispense = async ({ userId, orderId }) => {
  const provider = getIotDispenseProvider();

  if (!provider) {
    throw new BadRequestError('IoT pump unlock is not switched on for this server', {
      code: ERROR_CODES.IOT_DISPENSE_NOT_ENABLED,
    });
  }

  const driver = await resolveDriverProfile(userId);
  const order = await driverOrderRepository.findOrderForDriver({
    driverProfileId: driver.id,
    orderId,
  });

  if (!order) {
    throw new NotFoundError('Order not found', { code: ERROR_CODES.ORDER_NOT_FOUND });
  }

  if (!ALLOWED_STATUSES.includes(order.status)) {
    throw new ConflictError('Mark the order as arrived before unlocking the pump', {
      code: ERROR_CODES.INVALID_STATE_TRANSITION,
      details: { currentStatus: order.status },
    });
  }

  const existing = await prisma.iotDispenseAuthorization.findFirst({
    where: { orderId, status: 'AUTHORIZED' },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) return toAuthorization(existing, true);

  const reservation = order.reservations?.[0];

  if (!reservation || reservation.status !== RESERVATION_STATUS.HELD) {
    throw new ConflictError('This order holds no fuel on your tanker', {
      code: ERROR_CODES.RESERVATION_NOT_HELD,
    });
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: reservation.vehicleId },
    select: { id: true, registrationNumber: true, iotDeviceId: true },
  });

  if (!vehicle?.iotDeviceId) {
    throw new ConflictError('This tanker has no IoT device id set. Ask the admin to add it.', {
      code: ERROR_CODES.IOT_DEVICE_NOT_CONFIGURED,
    });
  }

  // Whole litres, rounded UP: billing is by measured delivery, and rounding
  // down would stop the pump short of what the customer ordered.
  const litres = Math.ceil(Number(order.quantity));
  const requestRef = requestRefFor();

  const base = {
    orderId,
    vehicleId: vehicle.id,
    deviceId: vehicle.iotDeviceId,
    vehicleRegistration: vehicle.registrationNumber,
    authorizedLitres: litres,
    requestRef,
    requestedByUserId: userId,
  };

  let result;

  try {
    result = await provider.authorize({
      deviceId: vehicle.iotDeviceId,
      vehicleRegistration: vehicle.registrationNumber,
      litres,
      requestRef,
    });
  } catch (err) {
    if (!(err instanceof IotDispenseError)) throw err;

    await prisma.iotDispenseAuthorization.create({
      data: {
        ...base,
        status: 'FAILED',
        errorMessage: err.message.slice(0, 500),
        raw: err.detail ?? undefined,
      },
    });

    throw new ServiceUnavailableError(`${err.message}. Try again in a moment.`, {
      code: ERROR_CODES.IOT_AUTHORIZATION_FAILED,
    });
  }

  const row = await prisma.iotDispenseAuthorization.create({
    data: {
      ...base,
      status: result.status.slice(0, 32),
      iotTransactionId: result.iotTransactionId,
      mpin: result.mpin,
      raw: result.raw,
    },
  });

  log.info(
    {
      orderId,
      deviceId: vehicle.iotDeviceId,
      status: result.status,
      iotTransactionId: result.iotTransactionId,
    },
    'IoT dispense authorize'
  );

  if (result.status !== 'AUTHORIZED' || !result.mpin) {
    throw new ConflictError(`The pump was not unlocked (status: ${result.status})`, {
      code: ERROR_CODES.IOT_AUTHORIZATION_FAILED,
      details: { status: result.status },
    });
  }

  return toAuthorization(row, false);
};
