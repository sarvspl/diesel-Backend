import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Fuel reservations (BR-406).
 *
 * OWNED BY DISPATCH (docs/06 §8), which is why this lives here rather than in
 * the ordering module even though Ordering is what triggers it. Fleet owns the
 * stock and exposes a lockable row; Dispatch owns the claim against it;
 * Ordering owns neither and calls this service.
 *
 * THE RACE THIS EXISTS TO LOSE CORRECTLY (docs/08 §9.1):
 *
 *   Two 200-litre orders arrive simultaneously for a tanker holding 300 litres.
 *   Both read the available quantity. Both see 300. Both succeed. One customer
 *   receives an apologetic phone call.
 *
 * The fix is not a cleverer check - it is a lock. `SELECT ... FOR UPDATE` on the
 * vehicle's inventory row serialises the two transactions, so the check-then-act
 * becomes atomic and the second one sees the first one's hold.
 */

const FIELDS = {
  id: true,
  orderId: true,
  vehicleId: true,
  quantity: true,
  status: true,
  expiresAt: true,
  releasedAt: true,
  releaseReason: true,
  consumedQuantity: true,
  createdByUserId: true,
  createdAt: true,
};

/**
 * Hold fuel, or fail because there is not enough.
 *
 * Everything below happens inside ONE transaction with the inventory row
 * locked. The sequence matters:
 *
 *   1. Lock `vehicle_inventory` FOR UPDATE. Nothing else may compute this
 *      vehicle's availability until this transaction ends.
 *   2. Re-read available and held INSIDE the lock. Values read before it are
 *      already stale.
 *   3. Verify `available - held >= required` (BR-406).
 *   4. Write the reservation and bump `held_quantity` together.
 *
 * Raw SQL for the lock because Prisma's fluent API has no `FOR UPDATE`
 * (ADR-003 flagged exactly this as the consequence that must be verified early
 * rather than discovered during the credit module).
 *
 * Stock is NOT deducted. Reserving is a promise; litres only move when fuel
 * physically does, at the actual dispensed quantity (BR-408).
 *
 * @returns {Promise<{ ok: true, reservation: object } | { ok: false, code: string, details: object }>}
 *   A result rather than a throw: "not enough fuel" is an ordinary answer the
 *   allocator loops past, not an exception.
 */
export const hold = async ({ orderId, vehicleId, quantity, expiresAt, createdByUserId }) =>
  prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw`
      SELECT current_quantity, held_quantity
      FROM vehicle_inventory
      WHERE vehicle_id = ${vehicleId}::uuid
      FOR UPDATE
    `;

    if (!locked) {
      return { ok: false, code: 'NO_INVENTORY', details: { vehicleId } };
    }

    /**
     * Compared in SQL-side numerics via the raw row, then again here as
     * strings through Decimal. The quantities are NUMERIC(12,3) and the
     * comparison decides whether fuel is promised twice, so it does not go
     * through JS floats.
     */
    const available = String(locked.current_quantity);
    const held = String(locked.held_quantity);

    const [{ sufficient, free }] = await tx.$queryRaw`
      SELECT
        (${available}::numeric - ${held}::numeric) >= ${String(quantity)}::numeric AS sufficient,
        (${available}::numeric - ${held}::numeric) AS free
    `;

    if (!sufficient) {
      return {
        ok: false,
        code: 'INSUFFICIENT_FUEL',
        details: {
          vehicleId,
          requested: String(quantity),
          availableToReserve: String(free),
        },
      };
    }

    const reservation = await tx.fuelReservation.create({
      data: {
        orderId,
        vehicleId,
        quantity: String(quantity),
        expiresAt,
        createdByUserId: createdByUserId ?? null,
      },
      select: FIELDS,
    });

    // held += quantity, in the database rather than in JS, so the arithmetic is
    // NUMERIC throughout and the read we validated against cannot go stale
    // between the check and the write.
    await tx.$executeRaw`
      UPDATE vehicle_inventory
      SET held_quantity = held_quantity + ${String(quantity)}::numeric,
          version = version + 1,
          updated_at = NOW()
      WHERE vehicle_id = ${vehicleId}::uuid
    `;

    return { ok: true, reservation };
  });

/**
 * Stop holding fuel, and give the litres back.
 *
 * Conditional on the row still being HELD: `updateMany ... where status = HELD`
 * returns a row count, and zero means someone else released it first. That is
 * the conditional-claim pattern (docs/08 §9.5) and it makes a double release
 * - the cancel endpoint racing the expiry sweeper - impossible to double-count.
 *
 * @param {string} finalStatus RELEASED | EXPIRED | CONSUMED
 */
export const settle = async ({ reservationId, finalStatus, reason, consumedQuantity = null }) =>
  prisma.$transaction(async (tx) => {
    const reservation = await tx.fuelReservation.findUnique({
      where: { id: reservationId },
      select: FIELDS,
    });

    if (!reservation) return { ok: false, code: 'NOT_FOUND' };

    // Lock the inventory row before touching held_quantity, for the same
    // reason `hold` does: two concurrent releases must not both subtract.
    await tx.$queryRaw`
      SELECT vehicle_id FROM vehicle_inventory
      WHERE vehicle_id = ${reservation.vehicleId}::uuid
      FOR UPDATE
    `;

    const { count } = await tx.fuelReservation.updateMany({
      where: { id: reservationId, status: 'HELD' },
      data: {
        status: finalStatus,
        releasedAt: new Date(),
        releaseReason: reason ?? null,
        consumedQuantity: consumedQuantity === null ? null : String(consumedQuantity),
      },
    });

    // Someone won the race. Do NOT touch held_quantity - they already did.
    if (count === 0) return { ok: false, code: 'NOT_HELD', reservation };

    await tx.$executeRaw`
      UPDATE vehicle_inventory
      SET held_quantity = GREATEST(held_quantity - ${String(reservation.quantity)}::numeric, 0),
          version = version + 1,
          updated_at = NOW()
      WHERE vehicle_id = ${reservation.vehicleId}::uuid
    `;

    const updated = await tx.fuelReservation.findUnique({
      where: { id: reservationId },
      select: FIELDS,
    });

    return { ok: true, reservation: updated };
  });

export const findById = async (id) =>
  prisma.fuelReservation.findUnique({ where: { id }, select: FIELDS });

/** The live hold for an order. At most one exists (INV-06). */
export const findActiveForOrder = async (orderId) =>
  prisma.fuelReservation.findFirst({
    where: { orderId, status: 'HELD' },
    select: FIELDS,
  });

export const listForOrder = async (orderId) =>
  prisma.fuelReservation.findMany({
    where: { orderId },
    select: FIELDS,
    orderBy: { createdAt: 'desc' },
  });

/** Held reservations past their expiry. Matches the partial index exactly. */
export const findLapsed = async ({ limit = 100, now = new Date() } = {}) =>
  prisma.fuelReservation.findMany({
    where: { status: 'HELD', expiresAt: { lt: now } },
    select: FIELDS,
    orderBy: { expiresAt: 'asc' },
    take: limit,
  });

/**
 * Sum of live holds for a vehicle.
 *
 * The INV-03 reconciliation check: this must equal `vehicle_inventory.held_quantity`.
 * Drift means something adjusted the cache without a reservation to account for
 * it, and the reservations - not the cache - are right.
 */
export const sumHeldForVehicle = async (vehicleId) => {
  const result = await prisma.fuelReservation.aggregate({
    where: { vehicleId, status: 'HELD' },
    _sum: { quantity: true },
  });

  return result._sum.quantity ?? '0';
};

/**
 * Vehicles that could take a given quantity right now.
 *
 * ADVISORY ONLY - it reads outside any lock, so by the time the caller acts the
 * answer may be stale. That is fine and expected: `hold` re-checks inside the
 * lock, and this exists only to avoid attempting fifty locks to find one
 * vehicle. Dispatch will replace it with proper candidate ranking (docs/07 §4);
 * this phase picks the first that fits.
 */
export const findCandidateVehicles = async ({ quantity, limit = 10 }) =>
  prisma.$queryRaw`
    SELECT v.id AS "vehicleId",
           v.vehicle_number AS "vehicleNumber",
           (i.current_quantity - i.held_quantity) AS "availableToReserve"
    FROM vehicles v
    JOIN vehicle_inventory i ON i.vehicle_id = v.id
    WHERE v.status = 'ACTIVE'
      AND v.retired_at IS NULL
      AND (i.current_quantity - i.held_quantity) >= ${String(quantity)}::numeric
    ORDER BY (i.current_quantity - i.held_quantity) ASC
    LIMIT ${limit}
  `;
