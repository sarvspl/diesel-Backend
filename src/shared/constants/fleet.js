/**
 * JavaScript mirrors of the fleet Prisma enums.
 *
 * Same reasoning as identity.js and corporate.js: without a compiler, a bare
 * string literal that drifts from the schema fails at runtime on whichever
 * branch happens to use it. The enum-parity test asserts these match.
 */

export const DRIVER_EMPLOYMENT_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  INACTIVE: 'INACTIVE',
});

export const DRIVER_AVAILABILITY = Object.freeze({
  OFFLINE: 'OFFLINE',
  ONLINE: 'ONLINE',
  ON_TRIP: 'ON_TRIP',
  BREAK: 'BREAK',
});

export const VEHICLE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  MAINTENANCE: 'MAINTENANCE',
  INACTIVE: 'INACTIVE',
  RETIRED: 'RETIRED',
});

export const SHIFT_STATUS = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
});

export const INVENTORY_ADJUSTMENT_TYPE = Object.freeze({
  OPENING_BALANCE: 'OPENING_BALANCE',
  REFILL: 'REFILL',
  MANUAL_INCREASE: 'MANUAL_INCREASE',
  MANUAL_DECREASE: 'MANUAL_DECREASE',
  DISPENSED: 'DISPENSED',
});

export const METER_READING_TYPE = Object.freeze({
  SHIFT_OPENING: 'SHIFT_OPENING',
  SHIFT_CLOSING: 'SHIFT_CLOSING',
  SPOT_CHECK: 'SPOT_CHECK',
  DELIVERY_START: 'DELIVERY_START',
  DELIVERY_END: 'DELIVERY_END',
});

export const METER_READING_SOURCE = Object.freeze({
  MANUAL_ENTRY: 'MANUAL_ENTRY',
  FLOW_METER_API: 'FLOW_METER_API',
  ESTIMATED: 'ESTIMATED',
});

export const FUEL_STOCK_SOURCE = Object.freeze({
  MANUAL: 'MANUAL',
  REFILL: 'REFILL',
  DIP: 'DIP',
  FLOW_METER: 'FLOW_METER',
});

/**
 * Adjustment types an operator may post through the API.
 *
 * DISPENSED is excluded: it is written by the delivery module from meter
 * readings, never typed by a human. Allowing it here would let someone reduce
 * stock without a delivery to account for it - which is what fuel theft looks
 * like in the books.
 *
 * OPENING_BALANCE is excluded too: it is posted once when a vehicle is created.
 */
export const OPERATOR_ADJUSTMENT_TYPES = Object.freeze([
  INVENTORY_ADJUSTMENT_TYPE.MANUAL_INCREASE,
  INVENTORY_ADJUSTMENT_TYPE.MANUAL_DECREASE,
]);

/** Meter reading types an operator may record directly. */
export const OPERATOR_READING_TYPES = Object.freeze([METER_READING_TYPE.SPOT_CHECK]);

/**
 * Why a vehicle is not dispatchable. Stable codes so dispatch and the admin UI
 * can branch on them rather than parsing prose.
 */
export const DISPATCH_BLOCKER = Object.freeze({
  NOT_ACTIVE: 'VEHICLE_NOT_ACTIVE',
  RETIRED: 'VEHICLE_RETIRED',
  CALIBRATION_EXPIRED: 'CALIBRATION_EXPIRED',
  PESO_EXPIRED: 'PESO_LICENSE_EXPIRED',
  INSURANCE_EXPIRED: 'INSURANCE_EXPIRED',
  FITNESS_EXPIRED: 'FITNESS_EXPIRED',
  PUC_EXPIRED: 'PUC_EXPIRED',
  NO_DRIVER_ASSIGNED: 'NO_DRIVER_ASSIGNED',
  FUEL_STATE_STALE: 'FUEL_STATE_STALE',
  NO_AVAILABLE_FUEL: 'NO_AVAILABLE_FUEL',
});
