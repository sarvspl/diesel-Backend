import { prisma } from '../../../infrastructure/database/prisma.js';

/**
 * Data access for driver profiles, shifts and meter readings.
 *
 * `licenseNumber` is excluded from list projections. It is personal data
 * (BR-303) and a fleet list has no need of it, so the smallest number of code
 * paths can leak it.
 */

const DRIVER_LIST_FIELDS = {
  id: true,
  userId: true,
  employeeCode: true,
  fullName: true,
  licenseExpiry: true,
  employmentStatus: true,
  availability: true,
  joinedOn: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, phone: true, status: true } },
};

/** Detail view. Includes the licence number; only the single-driver read uses it. */
const DRIVER_DETAIL_FIELDS = {
  ...DRIVER_LIST_FIELDS,
  licenseNumber: true,
  licenseDocumentKey: true,
  profileImageKey: true,
  emergencyContactName: true,
  emergencyContactPhone: true,
  notes: true,
};

export const findByUserId = async (userId) =>
  prisma.driverProfile.findUnique({ where: { userId }, select: DRIVER_DETAIL_FIELDS });

export const findById = async (id) =>
  prisma.driverProfile.findUnique({ where: { id }, select: DRIVER_DETAIL_FIELDS });

export const list = async ({ employmentStatus, limit, cursor }) =>
  prisma.driverProfile.findMany({
    where: { ...(employmentStatus ? { employmentStatus } : {}) },
    select: DRIVER_LIST_FIELDS,
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

export const create = async ({ data, actorUserId }) =>
  prisma.driverProfile.create({
    data: { ...data, createdByUserId: actorUserId, updatedByUserId: actorUserId },
    select: DRIVER_DETAIL_FIELDS,
  });

export const update = async ({ id, data, actorUserId }) =>
  prisma.driverProfile.update({
    where: { id },
    data: { ...data, updatedByUserId: actorUserId },
    select: DRIVER_DETAIL_FIELDS,
  });

export const setAvailability = async ({ id, availability }) =>
  prisma.driverProfile.update({
    where: { id },
    data: { availability },
    select: { id: true, availability: true },
  });

// --- Shifts ----------------------------------------------------------------

const SHIFT_FIELDS = {
  id: true,
  driverProfileId: true,
  driverUserId: true,
  vehicleId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  openingFuelQuantity: true,
  closingFuelQuantity: true,
  lastLatitude: true,
  lastLongitude: true,
  lastLocationAt: true,
  notes: true,
  openingMeterReading: { select: { id: true, totalizer: true, capturedAt: true, photoKey: true } },
  closingMeterReading: { select: { id: true, totalizer: true, capturedAt: true, photoKey: true } },
  driverProfile: { select: { id: true, fullName: true, employeeCode: true } },
  vehicle: { select: { id: true, vehicleNumber: true, registrationNumber: true } },
};

export const findOpenShiftForDriver = async (driverProfileId) =>
  prisma.driverShift.findFirst({
    where: { driverProfileId, status: 'OPEN' },
    select: SHIFT_FIELDS,
  });

export const findOpenShiftForVehicle = async (vehicleId) =>
  prisma.driverShift.findFirst({ where: { vehicleId, status: 'OPEN' }, select: SHIFT_FIELDS });

export const findShiftById = async (id) =>
  prisma.driverShift.findUnique({ where: { id }, select: SHIFT_FIELDS });

export const listShifts = async ({ status, driverProfileId, vehicleId, limit, cursor }) =>
  prisma.driverShift.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(driverProfileId ? { driverProfileId } : {}),
      ...(vehicleId ? { vehicleId } : {}),
    },
    select: SHIFT_FIELDS,
    orderBy: { startedAt: 'desc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

/**
 * Open a shift, recording its opening meter reading in the same transaction.
 *
 * The reading is created first and referenced by the shift, rather than its
 * totaliser being copied onto the shift row. One immutable home for the
 * reading means the shift and the reading can never disagree.
 *
 * Driver availability moves to ONLINE here: starting a shift IS coming on duty.
 */
export const openShift = async ({
  driverProfileId,
  driverUserId,
  vehicleId,
  openingTotalizer,
  openingFuelQuantity,
  photoKey,
  notes,
  actorUserId,
}) =>
  prisma.$transaction(async (tx) => {
    const reading = await tx.meterReading.create({
      data: {
        vehicleId,
        readingType: 'SHIFT_OPENING',
        totalizer: openingTotalizer,
        source: 'MANUAL_ENTRY',
        photoKey,
        recordedByUserId: actorUserId,
      },
      select: { id: true, totalizer: true },
    });

    const shift = await tx.driverShift.create({
      data: {
        driverProfileId,
        driverUserId,
        vehicleId,
        status: 'OPEN',
        openingMeterReadingId: reading.id,
        openingFuelQuantity,
        notes: notes ?? null,
        startedByUserId: actorUserId,
      },
      select: SHIFT_FIELDS,
    });

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: { availability: 'ONLINE' },
    });

    return shift;
  });

/** Close a shift and record its closing reading, atomically. */
export const closeShift = async ({
  shiftId,
  driverProfileId,
  vehicleId,
  closingTotalizer,
  closingFuelQuantity,
  photoKey,
  notes,
  actorUserId,
}) =>
  prisma.$transaction(async (tx) => {
    const reading = await tx.meterReading.create({
      data: {
        vehicleId,
        readingType: 'SHIFT_CLOSING',
        totalizer: closingTotalizer,
        source: 'MANUAL_ENTRY',
        photoKey,
        recordedByUserId: actorUserId,
      },
      select: { id: true },
    });

    const shift = await tx.driverShift.update({
      where: { id: shiftId },
      data: {
        status: 'CLOSED',
        endedAt: new Date(),
        closingMeterReadingId: reading.id,
        closingFuelQuantity,
        endedByUserId: actorUserId,
        ...(notes ? { notes } : {}),
      },
      select: SHIFT_FIELDS,
    });

    await tx.driverProfile.update({
      where: { id: driverProfileId },
      data: { availability: 'OFFLINE' },
    });

    return shift;
  });

// --- Meter readings --------------------------------------------------------

const READING_FIELDS = {
  id: true,
  vehicleId: true,
  readingType: true,
  totalizer: true,
  grossQuantity: true,
  netQuantity: true,
  temperatureC: true,
  source: true,
  photoKey: true,
  recordedByUserId: true,
  capturedAt: true,
  createdAt: true,
  notes: true,
};

/** Immutable: created, never updated. A wrong reading is superseded, not edited. */
export const createMeterReading = async (data) =>
  prisma.meterReading.create({ data, select: READING_FIELDS });

/** The most recent reading for a vehicle, for monotonicity checks (BR-903). */
export const findLatestReading = async (vehicleId) =>
  prisma.meterReading.findFirst({
    where: { vehicleId },
    select: READING_FIELDS,
    orderBy: [{ capturedAt: 'desc' }, { createdAt: 'desc' }],
  });

export const listReadings = async ({ vehicleId, limit, cursor }) =>
  prisma.meterReading.findMany({
    where: { vehicleId },
    select: READING_FIELDS,
    orderBy: { capturedAt: 'desc' },
    take: limit,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });
