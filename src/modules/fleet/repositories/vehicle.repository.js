import { prisma } from '../../../infrastructure/database/prisma.js';

/** Data access for vehicles, their inventory and their assignment history. */

const VEHICLE_FIELDS = {
  id: true,
  vehicleNumber: true,
  registrationNumber: true,
  makeModel: true,
  tankCapacity: true,
  compartmentCount: true,
  flowMeterEnabled: true,
  pesoLicenseNumber: true,
  pesoLicenseExpiry: true,
  calibrationCertNumber: true,
  calibrationExpiry: true,
  insuranceExpiry: true,
  pucExpiry: true,
  fitnessExpiry: true,
  status: true,
  retiredAt: true,
  retiredReason: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
};

const WITH_INVENTORY = {
  ...VEHICLE_FIELDS,
  inventory: {
    select: {
      currentQuantity: true,
      heldQuantity: true,
      lastSource: true,
      lastVerifiedAt: true,
      staleAfter: true,
      updatedAt: true,
    },
  },
};

/** The active assignment, if any. Empty array when the vehicle is unassigned. */
const ACTIVE_ASSIGNMENT = {
  where: { releasedAt: null },
  select: {
    id: true,
    assignedAt: true,
    driverProfileId: true,
    driverProfile: {
      select: { id: true, fullName: true, employeeCode: true, userId: true },
    },
  },
  take: 1,
};

export const findById = async (id) =>
  prisma.vehicle.findUnique({
    where: { id },
    select: { ...WITH_INVENTORY, assignments: ACTIVE_ASSIGNMENT },
  });

export const findByIdBasic = async (id) =>
  prisma.vehicle.findUnique({ where: { id }, select: VEHICLE_FIELDS });

/**
 * ONE `status` CLAUSE, CHOSEN — never two spreads onto the same key.
 *
 * This was written as `{ ...(status ? { status } : {}), ...(includeRetired ? {}
 * : { status: { not: 'RETIRED' } }) }`, and the second spread silently
 * overwrote the first: with `includeRetired` false (the default) an explicit
 * `?status=INACTIVE` was replaced by `not RETIRED`, so every filter chip in the
 * admin panel returned the same unfiltered list. Object spread has no collision
 * warning, and both halves read correctly on their own.
 *
 * An explicit status wins outright, including RETIRED — a caller asking for
 * retired vehicles by name has already said what they want, and the default
 * exclusion exists for the caller who said nothing.
 */
export const list = async ({ status, includeRetired, limit, cursor }) =>
  prisma.vehicle.findMany({
    where: status
      ? { status }
      : // Retired vehicles are excluded by default: they are soft-deleted, and
        // a fleet list that includes them is mostly history.
        includeRetired
        ? {}
        : { status: { not: 'RETIRED' } },
    select: { ...WITH_INVENTORY, assignments: ACTIVE_ASSIGNMENT },
    orderBy: { vehicleNumber: 'asc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

/**
 * Create a vehicle, its inventory row and an OPENING_BALANCE adjustment in one
 * transaction.
 *
 * The opening balance is posted even when it is zero. Without it the
 * adjustment log does not sum to the cached quantity, and the nightly
 * reconciliation would report every new vehicle as drifted.
 */
export const create = async ({ data, openingQuantity, actorUserId }) =>
  prisma.$transaction(async (tx) => {
    const vehicle = await tx.vehicle.create({
      data: {
        ...data,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
        inventory: {
          create: {
            currentQuantity: openingQuantity,
            lastSource: 'MANUAL',
            lastVerifiedAt: new Date(),
          },
        },
      },
      select: WITH_INVENTORY,
    });

    await tx.inventoryAdjustment.create({
      data: {
        vehicleId: vehicle.id,
        type: 'OPENING_BALANCE',
        quantityDelta: openingQuantity,
        quantityBefore: 0,
        quantityAfter: openingQuantity,
        reasonCode: 'VEHICLE_ONBOARDED',
        reason: 'Opening balance recorded when the vehicle was added to the fleet',
        performedByUserId: actorUserId,
        occurredAt: new Date(),
      },
    });

    return vehicle;
  });

export const update = async ({ id, data, actorUserId }) =>
  prisma.vehicle.update({
    where: { id },
    data: { ...data, updatedByUserId: actorUserId },
    select: { ...WITH_INVENTORY, assignments: ACTIVE_ASSIGNMENT },
  });

// --- Assignments -----------------------------------------------------------

export const findActiveAssignmentForVehicle = async (vehicleId) =>
  prisma.vehicleAssignment.findFirst({
    where: { vehicleId, releasedAt: null },
    select: { id: true, driverProfileId: true, assignedAt: true },
  });

export const findActiveAssignmentForDriver = async (driverProfileId) =>
  prisma.vehicleAssignment.findFirst({
    where: { driverProfileId, releasedAt: null },
    select: { id: true, vehicleId: true, assignedAt: true },
  });

/**
 * Bind a driver to a vehicle.
 *
 * The uniqueness rules - one active assignment per vehicle AND one active
 * vehicle per driver - are enforced by partial unique indexes on
 * `released_at IS NULL`. The service checks first for a good error message;
 * the index is what makes a concurrent double-assign impossible rather than
 * merely unlikely.
 */
export const createAssignment = async ({ vehicleId, driverProfileId, actorUserId }) =>
  prisma.vehicleAssignment.create({
    data: { vehicleId, driverProfileId, assignedByUserId: actorUserId },
    select: {
      id: true,
      vehicleId: true,
      driverProfileId: true,
      assignedAt: true,
      releasedAt: true,
    },
  });

/**
 * Swap one driver for another in a SINGLE transaction.
 *
 * Reassignment is the common operation - a driver calls in sick and the tanker
 * goes to someone else - and doing it as release-then-assign leaves a window
 * where the vehicle has nobody. If the second call fails, an operator who
 * meant to change the driver has instead removed one, and the vehicle is
 * NO_DRIVER_ASSIGNED until a human notices.
 *
 * The partial unique indexes on `released_at IS NULL` still do the real work:
 * the release must land before the create, or the vehicle index rejects it.
 * That ordering is guaranteed here because both are in the same transaction.
 */
export const replaceAssignment = async ({
  currentAssignmentId,
  vehicleId,
  driverProfileId,
  actorUserId,
  reason,
}) =>
  prisma.$transaction(async (tx) => {
    await tx.vehicleAssignment.update({
      where: { id: currentAssignmentId },
      data: {
        releasedAt: new Date(),
        releasedByUserId: actorUserId,
        releaseReason: reason ?? 'Reassigned to another driver',
      },
    });

    return tx.vehicleAssignment.create({
      data: { vehicleId, driverProfileId, assignedByUserId: actorUserId },
      select: {
        id: true,
        vehicleId: true,
        driverProfileId: true,
        assignedAt: true,
        releasedAt: true,
      },
    });
  });

/**
 * Release an assignment. Never deleted - "who was driving on the 14th" must
 * stay answerable (history is append-only).
 */
export const releaseAssignment = async ({ id, actorUserId, reason }) =>
  prisma.vehicleAssignment.update({
    where: { id },
    data: { releasedAt: new Date(), releasedByUserId: actorUserId, releaseReason: reason ?? null },
    select: {
      id: true,
      vehicleId: true,
      driverProfileId: true,
      assignedAt: true,
      releasedAt: true,
      releaseReason: true,
    },
  });

export const listAssignmentHistory = async ({ vehicleId, limit, cursor }) =>
  prisma.vehicleAssignment.findMany({
    where: { vehicleId },
    select: {
      id: true,
      assignedAt: true,
      releasedAt: true,
      releaseReason: true,
      assignedByUserId: true,
      releasedByUserId: true,
      driverProfile: {
        select: { id: true, fullName: true, employeeCode: true, userId: true },
      },
    },
    orderBy: { assignedAt: 'desc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });
