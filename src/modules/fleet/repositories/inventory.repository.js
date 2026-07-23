import { env } from '../../../config/env.js';
import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Fuel stock: an append-only movement log with a cached balance.
 *
 * NOTHING may write `currentQuantity` directly. Every change goes through
 * `postAdjustment`, which writes the log row and the cache in one transaction.
 * This is ADR-006's ledger principle applied to litres, and for the same
 * reason: a mutable quantity column has no history, cannot be audited, races,
 * and cannot be corrected once real fuel has moved.
 */

const ADJUSTMENT_FIELDS = {
  id: true,
  vehicleId: true,
  type: true,
  quantityDelta: true,
  quantityBefore: true,
  quantityAfter: true,
  reasonCode: true,
  reason: true,
  depotName: true,
  invoiceRef: true,
  photoKey: true,
  occurredAt: true,
  performedByUserId: true,
  createdAt: true,
};

export const findInventory = async (vehicleId) =>
  prisma.vehicleInventory.findUnique({
    where: { vehicleId },
    select: {
      vehicleId: true,
      currentQuantity: true,
      heldQuantity: true,
      lastSource: true,
      lastVerifiedAt: true,
      staleAfter: true,
      version: true,
      updatedAt: true,
    },
  });

/**
 * Post a fuel movement.
 *
 * Locks the inventory row FOR UPDATE before reading the balance, so two
 * concurrent adjustments cannot both compute from the same starting figure and
 * lose one of the movements. This is the same serialisation BR-406 will need
 * for reservations - proving it works here means dispatch inherits a pattern
 * that is already exercised.
 *
 * Raw SQL for the lock because Prisma has no `FOR UPDATE` in its fluent API
 * (ADR-003 flagged exactly this).
 *
 * @param {object} params
 * @param {string} params.vehicleId
 * @param {string} params.type
 * @param {string|number} params.quantityDelta  Signed litres.
 * @param {number} [params.capacity]            Tank capacity, to reject overfill.
 * @returns {Promise<object>} the created adjustment
 */
export const postAdjustment = async ({
  vehicleId,
  type,
  quantityDelta,
  reasonCode,
  reason,
  depotName,
  invoiceRef,
  photoKey,
  occurredAt,
  performedByUserId,
  source,
  capacity,
}) =>
  prisma.$transaction(async (tx) => {
    // Serialises concurrent movements for this vehicle. Without it, two
    // refills read the same `before` and one silently overwrites the other.
    const [locked] = await tx.$queryRaw`
      SELECT current_quantity, version
      FROM vehicle_inventory
      WHERE vehicle_id = ${vehicleId}::uuid
      FOR UPDATE
    `;

    if (!locked) {
      throw new Error(`No inventory row for vehicle ${vehicleId}`);
    }

    const before = Number(locked.current_quantity);
    const delta = Number(quantityDelta);
    const after = before + delta;

    // Invariants checked inside the lock, where they are actually true.
    if (after < 0) {
      const error = new Error('INSUFFICIENT_FUEL');
      error.code = 'INSUFFICIENT_FUEL';
      error.detail = { current: before, requested: Math.abs(delta) };
      throw error;
    }

    if (capacity !== undefined && after > Number(capacity)) {
      const error = new Error('EXCEEDS_CAPACITY');
      error.code = 'EXCEEDS_CAPACITY';
      error.detail = { current: before, resulting: after, capacity: Number(capacity) };
      throw error;
    }

    const adjustment = await tx.inventoryAdjustment.create({
      data: {
        vehicleId,
        type,
        quantityDelta: delta,
        quantityBefore: before,
        quantityAfter: after,
        reasonCode: reasonCode ?? null,
        reason: reason ?? null,
        depotName: depotName ?? null,
        invoiceRef: invoiceRef ?? null,
        photoKey: photoKey ?? null,
        occurredAt: occurredAt ?? new Date(),
        performedByUserId,
      },
      select: ADJUSTMENT_FIELDS,
    });

    await tx.vehicleInventory.update({
      where: { vehicleId },
      data: {
        currentQuantity: after,
        // A human just looked at the tank, so the figure is freshly verified.
        lastSource: source,
        lastVerifiedAt: new Date(),
        /**
         * PUSH THE STALENESS DEADLINE FORWARD TOO.
         *
         * `staleAfter` was read by `dispatchability` but written by nothing
         * except the seed, so once a vehicle's window lapsed it was
         * FUEL_STATE_STALE permanently — every tanker in the fleet showed
         * "Fuel level unverified" and no action in the product could clear it.
         * Verifying a level and not extending its validity is only half the
         * operation.
         */
        staleAfter: staleDeadline(),
        version: { increment: 1 },
      },
    });

    return adjustment;
  });

/** Now plus the configured trust window. */
const staleDeadline = () =>
  new Date(Date.now() + env.INVENTORY_STALE_AFTER_HOURS * 3_600_000);

/**
 * Confirm the level WITHOUT moving it.
 *
 * A dip that agrees with the recorded figure posts no adjustment — there is no
 * movement to record, and inventing a zero-quantity one would put noise in the
 * ledger an auditor has to read past. What it does do is restate that a human
 * looked, which is the whole point: the stock was never in doubt, its
 * freshness was.
 */
export const markVerified = async ({ vehicleId, source = 'DIP' }) =>
  prisma.vehicleInventory.update({
    where: { vehicleId },
    data: {
      lastSource: source,
      lastVerifiedAt: new Date(),
      staleAfter: staleDeadline(),
      version: { increment: 1 },
    },
    select: {
      vehicleId: true,
      currentQuantity: true,
      lastSource: true,
      lastVerifiedAt: true,
      staleAfter: true,
    },
  });

export const listAdjustments = async ({ vehicleId, limit, cursor }) =>
  prisma.inventoryAdjustment.findMany({
    where: { vehicleId },
    select: ADJUSTMENT_FIELDS,
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

/**
 * Sum the movement log for a vehicle.
 *
 * The reconciliation check: this must equal the cached `currentQuantity`
 * (the fuel analogue of INV-02). Any drift means something wrote the cache
 * directly, and the log - not the cache - is right.
 */
export const sumAdjustments = async (vehicleId) => {
  const result = await prisma.inventoryAdjustment.aggregate({
    where: { vehicleId },
    _sum: { quantityDelta: true },
  });

  return result._sum.quantityDelta ?? 0;
};
