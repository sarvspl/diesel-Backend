import { ERROR_CODES } from '../../../shared/constants/error-codes.js';
import {
  FUEL_STOCK_SOURCE,
  INVENTORY_ADJUSTMENT_TYPE,
  METER_READING_SOURCE,
  METER_READING_TYPE,
} from '../../../shared/constants/fleet.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../../shared/errors/index.js';
import { createLogger } from '../../../shared/logger/index.js';
import * as driverRepository from '../repositories/driver.repository.js';
import * as inventoryRepository from '../repositories/inventory.repository.js';
import * as vehicleRepository from '../repositories/vehicle.repository.js';

const log = createLogger({ module: 'fleet.inventory' });

/**
 * Fuel stock movements.
 *
 * EVERY change to stock is an append-only adjustment. There is no code path
 * that sets a quantity directly, which is what "never allow direct inventory
 * overwrite" actually requires: the log is the truth and the quantity column
 * is a cache over it (ADR-006 applied to litres).
 *
 * Remaining fuel is NOT derived from the meter (BR-404). A meter counts what
 * was dispensed; it has no idea what is left. Stock = opening + refills −
 * dispensed ± corrections, which is exactly what this log sums to.
 */

/** Translate a locked-transaction failure into an HTTP-shaped error. */
const translateAdjustmentError = (error) => {
  if (error?.code === 'INSUFFICIENT_FUEL') {
    return new ConflictError(
      `The vehicle holds ${error.detail.current} litres; cannot remove ${error.detail.requested}.`,
      { code: ERROR_CODES.INSUFFICIENT_FUEL, details: error.detail }
    );
  }

  if (error?.code === 'EXCEEDS_CAPACITY') {
    return new ConflictError(
      `That would put ${error.detail.resulting} litres into a ${error.detail.capacity} litre tank.`,
      { code: ERROR_CODES.EXCEEDS_CAPACITY, details: error.detail }
    );
  }

  return error;
};

const loadVehicleOrThrow = async (vehicleId) => {
  const vehicle = await vehicleRepository.findByIdBasic(vehicleId);

  if (!vehicle) throw new NotFoundError('Vehicle not found');
  if (vehicle.status === 'RETIRED') {
    throw new ConflictError('A retired vehicle cannot record fuel movements', {
      code: ERROR_CODES.VEHICLE_RETIRED,
    });
  }

  return vehicle;
};

const toPublicAdjustment = (adjustment) => ({
  id: adjustment.id,
  vehicleId: adjustment.vehicleId,
  type: adjustment.type,
  quantityDelta: String(adjustment.quantityDelta),
  quantityBefore: String(adjustment.quantityBefore),
  quantityAfter: String(adjustment.quantityAfter),
  reasonCode: adjustment.reasonCode,
  reason: adjustment.reason,
  depotName: adjustment.depotName,
  invoiceRef: adjustment.invoiceRef,
  photoKey: adjustment.photoKey,
  occurredAt: adjustment.occurredAt,
  performedByUserId: adjustment.performedByUserId,
  createdAt: adjustment.createdAt,
});

/**
 * Record a depot refill (BR-410).
 *
 * Always an increase, so the quantity is validated as positive and the sign is
 * applied here rather than trusted from the caller - a negative "refill" would
 * be a stock reduction with none of the scrutiny a manual decrease attracts.
 */
export const recordRefill = async ({ vehicleId, actorUserId, quantity, ...input }) => {
  const vehicle = await loadVehicleOrThrow(vehicleId);

  try {
    const adjustment = await inventoryRepository.postAdjustment({
      vehicleId,
      type: INVENTORY_ADJUSTMENT_TYPE.REFILL,
      quantityDelta: quantity,
      reasonCode: 'DEPOT_REFILL',
      reason: input.notes ?? null,
      depotName: input.depotName,
      invoiceRef: input.invoiceRef,
      photoKey: input.photoKey,
      occurredAt: input.occurredAt,
      performedByUserId: actorUserId,
      source: FUEL_STOCK_SOURCE.REFILL,
      capacity: vehicle.tankCapacity,
    });

    log.info({ vehicleId, quantity, actorUserId }, 'refill recorded');

    return toPublicAdjustment(adjustment);
  } catch (error) {
    throw translateAdjustmentError(error);
  }
};

/**
 * Correct stock by hand.
 *
 * A reason is MANDATORY and is enforced in three places - Zod, this service and
 * a database CHECK. An unexplained stock reduction is indistinguishable from
 * theft, and this is the endpoint someone would use to conceal it. It also
 * carries its own permission, separate from recording a refill.
 */
export const recordManualAdjustment = async ({
  vehicleId,
  actorUserId,
  direction,
  quantity,
  reasonCode,
  reason,
  photoKey,
}) => {
  const vehicle = await loadVehicleOrThrow(vehicleId);

  const isIncrease = direction === 'INCREASE';
  const delta = isIncrease ? Number(quantity) : -Number(quantity);

  try {
    const adjustment = await inventoryRepository.postAdjustment({
      vehicleId,
      type: isIncrease
        ? INVENTORY_ADJUSTMENT_TYPE.MANUAL_INCREASE
        : INVENTORY_ADJUSTMENT_TYPE.MANUAL_DECREASE,
      quantityDelta: delta,
      reasonCode,
      reason,
      photoKey,
      occurredAt: new Date(),
      performedByUserId: actorUserId,
      // A human physically checked the tank, so this becomes a DIP reading.
      source: FUEL_STOCK_SOURCE.DIP,
      capacity: vehicle.tankCapacity,
    });

    // Logged at warn, not info: manual corrections are the movements an
    // auditor asks about, and they should stand out in the log.
    log.warn({ vehicleId, delta, reasonCode, actorUserId }, 'manual fuel adjustment recorded');

    return toPublicAdjustment(adjustment);
  } catch (error) {
    throw translateAdjustmentError(error);
  }
};

/**
 * Record a manual meter reading.
 *
 * Readings are IMMUTABLE and append-only. A reading that turns out to be wrong
 * is superseded by a later one plus a note; it is never edited, because the
 * mistake is itself evidence.
 *
 * Deliberately does NOT change stock. A meter measures dispensed volume, not
 * tank contents (BR-404); inferring stock from a reading here would double
 * count against the delivery that will post the DISPENSED adjustment later.
 */
export const recordMeterReading = async ({ vehicleId, actorUserId, ...input }) => {
  await loadVehicleOrThrow(vehicleId);

  const latest = await driverRepository.findLatestReading(vehicleId);

  // BR-903: a totaliser is a lifetime counter and cannot run backwards. Real
  // causes are a meter reset, the wrong meter, or a transposed digit - all of
  // which need a human, not a silent accept.
  if (latest && Number(input.totalizer) < Number(latest.totalizer)) {
    throw new BadRequestError(
      `Reading ${input.totalizer} is below the last recorded reading ${latest.totalizer}. ` +
        'A totaliser cannot decrease - check for a meter reset or a transposed digit.',
      {
        code: ERROR_CODES.METER_READING_REGRESSION,
        details: { submitted: String(input.totalizer), lastRecorded: String(latest.totalizer) },
      }
    );
  }

  // BR-906: manual entry requires photographic evidence. Enforced in Zod too;
  // repeated here because this is the invariant, not the input format.
  if (!input.photoKey) {
    throw new BadRequestError('A photograph of the meter is required for a manual reading', {
      code: ERROR_CODES.METER_PHOTO_REQUIRED,
    });
  }

  const reading = await driverRepository.createMeterReading({
    vehicleId,
    readingType: input.readingType ?? METER_READING_TYPE.SPOT_CHECK,
    totalizer: input.totalizer,
    grossQuantity: input.grossQuantity ?? null,
    netQuantity: input.netQuantity ?? null,
    temperatureC: input.temperatureC ?? null,
    source: METER_READING_SOURCE.MANUAL_ENTRY,
    photoKey: input.photoKey,
    recordedByUserId: actorUserId,
    capturedAt: input.capturedAt ?? new Date(),
    notes: input.notes ?? null,
  });

  log.info({ vehicleId, readingId: reading.id, actorUserId }, 'meter reading recorded');

  return {
    ...reading,
    totalizer: String(reading.totalizer),
    grossQuantity: reading.grossQuantity === null ? null : String(reading.grossQuantity),
    netQuantity: reading.netQuantity === null ? null : String(reading.netQuantity),
  };
};

export const getInventory = async (vehicleId) => {
  const inventory = await inventoryRepository.findInventory(vehicleId);

  if (!inventory) throw new NotFoundError('Vehicle not found');

  return {
    vehicleId,
    currentQuantity: String(inventory.currentQuantity),
    heldQuantity: String(inventory.heldQuantity),
    availableQuantity: String(Number(inventory.currentQuantity) - Number(inventory.heldQuantity)),
    lastSource: inventory.lastSource,
    lastVerifiedAt: inventory.lastVerifiedAt,
    staleAfter: inventory.staleAfter,
  };
};

/**
 * Reconcile the cached quantity against the movement log.
 *
 * The fuel analogue of the ledger drift check (INV-02). Drift means something
 * wrote the cache directly, and the LOG is right. Intended for a nightly job
 * and for the variance report in BR-411; no scheduler exists yet.
 */
export const reconcileInventory = async (vehicleId) => {
  const inventory = await inventoryRepository.findInventory(vehicleId);

  if (!inventory) throw new NotFoundError('Vehicle not found');

  const logSum = Number(await inventoryRepository.sumAdjustments(vehicleId));
  const cached = Number(inventory.currentQuantity);
  const drift = Number((cached - logSum).toFixed(3));

  if (drift !== 0) {
    log.error(
      { vehicleId, cached, logSum, drift },
      'fuel inventory drift detected - the adjustment log is authoritative'
    );
  }

  return { vehicleId, cachedQuantity: String(cached), ledgerQuantity: String(logSum), drift };
};
