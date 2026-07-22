import '../helpers/env.js';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  CORPORATE_ACCOUNT_STATUS,
  CORPORATE_CREDIT_FACILITY_STATUS,
  CORPORATE_MEMBER_ROLE,
  CORPORATE_MEMBER_STATUS,
  CORPORATE_REGISTRATION_ID_TYPE,
  CORPORATE_VERIFICATION_STATUS,
} from '../../src/shared/constants/corporate.js';
import {
  DRIVER_AVAILABILITY,
  DRIVER_EMPLOYMENT_STATUS,
  FUEL_STOCK_SOURCE,
  INVENTORY_ADJUSTMENT_TYPE,
  METER_READING_SOURCE,
  METER_READING_TYPE,
  SHIFT_STATUS,
  VEHICLE_STATUS,
} from '../../src/shared/constants/fleet.js';
import {
  DEVICE_PLATFORM,
  OTP_PURPOSE,
  SESSION_REVOCATION_REASON,
  USER_STATUS,
} from '../../src/shared/constants/identity.js';
import {
  ACTOR_KIND,
  IDEMPOTENCY_STATE,
  ORDER_STATUS,
  OUTBOX_STATUS,
  PAYMENT_MODE,
  PAYMENT_STATUS,
  RESERVATION_STATUS,
  SETTLEMENT_STATUS,
} from '../../src/shared/constants/order.js';
import {
  CATALOG_STATUS,
  DELIVERY_CHARGE_TYPE,
  FUEL_UNIT,
  PRICE_STATUS,
  QUOTE_STATUS,
  TAX_APPLIES_TO,
  TAX_CALCULATION_TYPE,
  TAX_REGIME,
} from '../../src/shared/constants/pricing.js';
import { PRINCIPALS } from '../../src/shared/constants/rbac.js';

/**
 * The JavaScript enum mirrors must match the Prisma schema exactly.
 *
 * Without a compiler, a value added to the schema and forgotten in the mirror
 * (or vice versa) fails at runtime, on whichever branch happens to use it -
 * for TOKEN_REUSE_DETECTED that means only while someone is being attacked.
 * This test is the substitute for the type check that does not exist.
 */

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');

/** Pull the members of `enum <name> { ... }` out of the schema text. */
const prismaEnumValues = (name) => {
  const match = new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`).exec(schema);
  assert.ok(match, `enum ${name} not found in schema.prisma`);

  return match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => /^[A-Z_]+$/.test(line))
    .sort();
};

describe('enum parity with the Prisma schema', () => {
  const cases = [
    ['Principal', PRINCIPALS],
    ['UserStatus', USER_STATUS],
    ['SessionRevocationReason', SESSION_REVOCATION_REASON],
    ['DevicePlatform', DEVICE_PLATFORM],
    ['OtpPurpose', OTP_PURPOSE],
    ['CorporateVerificationStatus', CORPORATE_VERIFICATION_STATUS],
    ['CorporateAccountStatus', CORPORATE_ACCOUNT_STATUS],
    ['CorporateCreditFacilityStatus', CORPORATE_CREDIT_FACILITY_STATUS],
    ['CorporateMemberRole', CORPORATE_MEMBER_ROLE],
    ['CorporateMemberStatus', CORPORATE_MEMBER_STATUS],
    ['CorporateRegistrationIdType', CORPORATE_REGISTRATION_ID_TYPE],
    ['DriverEmploymentStatus', DRIVER_EMPLOYMENT_STATUS],
    ['DriverAvailability', DRIVER_AVAILABILITY],
    ['VehicleStatus', VEHICLE_STATUS],
    ['ShiftStatus', SHIFT_STATUS],
    ['InventoryAdjustmentType', INVENTORY_ADJUSTMENT_TYPE],
    ['MeterReadingType', METER_READING_TYPE],
    ['MeterReadingSource', METER_READING_SOURCE],
    ['FuelStockSource', FUEL_STOCK_SOURCE],
    ['FuelUnit', FUEL_UNIT],
    ['CatalogStatus', CATALOG_STATUS],
    ['PriceStatus', PRICE_STATUS],
    ['TaxRegime', TAX_REGIME],
    ['TaxCalculationType', TAX_CALCULATION_TYPE],
    ['TaxAppliesTo', TAX_APPLIES_TO],
    ['DeliveryChargeType', DELIVERY_CHARGE_TYPE],
    ['QuoteStatus', QUOTE_STATUS],
    ['OrderStatus', ORDER_STATUS],
    ['PaymentStatus', PAYMENT_STATUS],
    ['SettlementStatus', SETTLEMENT_STATUS],
    ['PaymentMode', PAYMENT_MODE],
    ['ActorKind', ACTOR_KIND],
    ['ReservationStatus', RESERVATION_STATUS],
    ['IdempotencyState', IDEMPOTENCY_STATE],
    ['OutboxStatus', OUTBOX_STATUS],
  ];

  for (const [enumName, mirror] of cases) {
    it(`${enumName} matches its JavaScript mirror`, () => {
      assert.deepEqual(Object.values(mirror).sort(), prismaEnumValues(enumName));
    });

    it(`${enumName} mirror keys equal their values`, () => {
      // A mismatched key/value pair silently writes the wrong enum member.
      for (const [key, value] of Object.entries(mirror)) {
        assert.equal(key, value, `${enumName}.${key} has value "${value}"`);
      }
    });
  }
});
