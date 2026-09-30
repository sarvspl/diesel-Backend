import { env } from '../../../config/env.js';
import { prisma } from '../../../infrastructure/database/prisma.js';
import {
  computeRoute,
  straightLineMeters,
} from '../../../infrastructure/providers/maps/google-routes.js';
import { RESERVATION_STATUS } from '../../../shared/constants/order.js';

/**
 * Where is the tanker for an order, and how far is it from the customer?
 *
 * The tanker's position is the phone of the driver holding it: order →
 * HELD/CONSUMED reservation → vehicle → active VehicleAssignment → driver
 * profile's last reported position. Only as fresh as the app last reported it.
 */

/** Statuses in which the customer is shown a tanker on the map. */
export const TRACKABLE_STATUSES = ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'DISPENSING'];

/** Statuses in which a road route (and ETA) is worth computing. */
const ROUTED_STATUSES = ['ASSIGNED', 'EN_ROUTE'];

const toPoint = (lat, lng) => {
  const latitude = Number(lat);
  const longitude = Number(lng);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
};

export const destinationOf = (addressSnapshot) =>
  toPoint(addressSnapshot?.latitude, addressSnapshot?.longitude);

/** Remember where a driver is. Profile always; the open shift too, if any. */
export const recordDriverLocation = async ({ driverProfileId, latitude, longitude }) => {
  const now = new Date();

  await prisma.$transaction([
    prisma.driverProfile.update({
      where: { id: driverProfileId },
      data: { lastLatitude: latitude, lastLongitude: longitude, lastLocationAt: now },
    }),
    prisma.driverShift.updateMany({
      where: { driverProfileId, status: 'OPEN' },
      data: { lastLatitude: latitude, lastLongitude: longitude, lastLocationAt: now },
    }),
  ]);
};

/** The tanker's last known position for an order, or null. */
export const tankerLocationForOrder = async (orderId) => {
  const reservation = await prisma.fuelReservation.findFirst({
    where: {
      orderId,
      status: { in: [RESERVATION_STATUS.HELD, RESERVATION_STATUS.CONSUMED] },
    },
    orderBy: { createdAt: 'desc' },
    select: { vehicleId: true },
  });

  if (!reservation) return null;

  const assignment = await prisma.vehicleAssignment.findFirst({
    where: { vehicleId: reservation.vehicleId, releasedAt: null },
    select: {
      driverProfile: {
        select: { lastLatitude: true, lastLongitude: true, lastLocationAt: true },
      },
    },
  });

  const driver = assignment?.driverProfile;
  const point = driver && toPoint(driver.lastLatitude, driver.lastLongitude);

  if (!point || !driver.lastLocationAt) return null;

  const ageSeconds = (Date.now() - driver.lastLocationAt.getTime()) / 1000;

  return {
    ...point,
    updatedAt: driver.lastLocationAt,
    stale: ageSeconds > env.DRIVER_LOCATION_STALE_SECONDS,
  };
};

/**
 * Route from `origin` to `destination`: Google's road route when a server key
 * is configured, otherwise a straight-line distance with no line or ETA.
 */
export const routeBetween = async (origin, destination) => {
  if (!origin || !destination) return null;

  const road = await computeRoute({ origin, destination });

  if (road) return { source: 'GOOGLE', ...road };

  return {
    source: 'STRAIGHT_LINE',
    distanceMeters: straightLineMeters(origin, destination),
    durationSeconds: null,
    polyline: null,
  };
};

/** The customer's tracking view of one order. */
export const trackingForOrder = async (order) => {
  const destination = destinationOf(order.addressSnapshot);
  const trackable = TRACKABLE_STATUSES.includes(order.status);

  const tanker = trackable ? await tankerLocationForOrder(order.id) : null;
  const route =
    tanker && !tanker.stale && ROUTED_STATUSES.includes(order.status)
      ? await routeBetween(tanker, destination)
      : null;

  return { orderId: order.id, status: order.status, destination, tanker, route };
};
