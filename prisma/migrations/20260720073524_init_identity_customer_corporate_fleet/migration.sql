-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Principal" AS ENUM ('CUSTOMER', 'DRIVER', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'DELETED');

-- CreateEnum
CREATE TYPE "SessionRevocationReason" AS ENUM ('LOGOUT', 'LOGOUT_ALL', 'DEVICE_REVOKED', 'TOKEN_REUSE_DETECTED', 'ADMIN_REVOKED', 'PASSWORD_CHANGED', 'ACCOUNT_BLOCKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DevicePlatform" AS ENUM ('ANDROID', 'IOS', 'WEB', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OtpPurpose" AS ENUM ('LOGIN', 'SIGNUP', 'PHONE_VERIFICATION', 'EMAIL_VERIFICATION', 'PASSWORD_RESET', 'PHONE_CHANGE');

-- CreateEnum
CREATE TYPE "CorporateVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CorporateAccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CorporateCreditFacilityStatus" AS ENUM ('NOT_ENABLED', 'ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CorporateMemberRole" AS ENUM ('CORPORATE_OWNER', 'CORPORATE_ADMIN', 'PURCHASE_MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "CorporateMemberStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "CorporateRegistrationIdType" AS ENUM ('CIN', 'GSTIN', 'PAN', 'UDYAM', 'OTHER');

-- CreateEnum
CREATE TYPE "DriverEmploymentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "DriverAvailability" AS ENUM ('OFFLINE', 'ONLINE', 'ON_TRIP', 'BREAK');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'INACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "InventoryAdjustmentType" AS ENUM ('OPENING_BALANCE', 'REFILL', 'MANUAL_INCREASE', 'MANUAL_DECREASE', 'DISPENSED');

-- CreateEnum
CREATE TYPE "MeterReadingType" AS ENUM ('SHIFT_OPENING', 'SHIFT_CLOSING', 'SPOT_CHECK', 'DELIVERY_START', 'DELIVERY_END');

-- CreateEnum
CREATE TYPE "MeterReadingSource" AS ENUM ('MANUAL_ENTRY', 'FLOW_METER_API', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "FuelStockSource" AS ENUM ('MANUAL', 'REFILL', 'DIP', 'FLOW_METER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "principal" "Principal" NOT NULL,
    "phone" VARCHAR(20),
    "email" VARCHAR(255),
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "phone_verified_at" TIMESTAMPTZ(6),
    "email_verified_at" TIMESTAMPTZ(6),
    "consent_version" VARCHAR(32),
    "consent_at" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" VARCHAR(64) NOT NULL,
    "rotation_counter" INTEGER NOT NULL DEFAULT 0,
    "device_id" VARCHAR(128),
    "device_name" VARCHAR(128),
    "platform" "DevicePlatform" NOT NULL DEFAULT 'UNKNOWN',
    "app_version" VARCHAR(32),
    "user_agent" VARCHAR(512),
    "ip_address" VARCHAR(45),
    "is_trusted" BOOLEAN NOT NULL DEFAULT false,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" "SessionRevocationReason",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL,
    "identifier" VARCHAR(255) NOT NULL,
    "principal" "Principal" NOT NULL,
    "purpose" "OtpPurpose" NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "resend_count" INTEGER NOT NULL DEFAULT 0,
    "consumed_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(128) NOT NULL,
    "resource" VARCHAR(64) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "full_name" VARCHAR(120),
    "preferred_language" VARCHAR(12) NOT NULL DEFAULT 'en',
    "profile_image_key" VARCHAR(512),
    "emergency_contact_name" VARCHAR(120),
    "emergency_contact_phone" VARCHAR(20),
    "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "marketing_opt_in_at" TIMESTAMPTZ(6),
    "notify_by_push" BOOLEAN NOT NULL DEFAULT true,
    "notify_by_sms" BOOLEAN NOT NULL DEFAULT true,
    "notify_by_email" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "corporate_account_id" UUID,
    "nickname" VARCHAR(80),
    "line1" VARCHAR(255) NOT NULL,
    "line2" VARCHAR(255),
    "landmark" VARCHAR(255),
    "city" VARCHAR(120) NOT NULL,
    "state" VARCHAR(120) NOT NULL,
    "pincode" VARCHAR(12) NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "google_place_id" VARCHAR(255),
    "delivery_instructions" VARCHAR(500),
    "contact_name" VARCHAR(120),
    "contact_phone" VARCHAR(20),
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_serviceable" BOOLEAN,
    "service_checked_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_accounts" (
    "id" UUID NOT NULL,
    "legal_name" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "registration_id_type" "CorporateRegistrationIdType" NOT NULL,
    "registration_number" VARCHAR(64) NOT NULL,
    "gstin" VARCHAR(15),
    "pan" VARCHAR(10),
    "billing_line1" VARCHAR(255),
    "billing_line2" VARCHAR(255),
    "billing_city" VARCHAR(120),
    "billing_state" VARCHAR(120),
    "billing_pincode" VARCHAR(12),
    "contact_email" VARCHAR(255),
    "contact_phone" VARCHAR(20),
    "verification_status" "CorporateVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "account_status" "CorporateAccountStatus" NOT NULL DEFAULT 'INACTIVE',
    "suspension_reason" VARCHAR(500),
    "credit_facility_status" "CorporateCreditFacilityStatus" NOT NULL DEFAULT 'NOT_ENABLED',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "corporate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_members" (
    "id" UUID NOT NULL,
    "corporate_account_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "CorporateMemberRole" NOT NULL,
    "status" "CorporateMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "removed_at" TIMESTAMPTZ(6),
    "added_by_user_id" UUID,
    "removed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "corporate_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_verification_records" (
    "id" UUID NOT NULL,
    "corporate_account_id" UUID NOT NULL,
    "from_status" "CorporateVerificationStatus",
    "to_status" "CorporateVerificationStatus" NOT NULL,
    "reason_code" VARCHAR(64),
    "applicant_note" VARCHAR(1000),
    "admin_note" VARCHAR(2000),
    "reviewed_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "corporate_verification_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "employee_code" VARCHAR(32),
    "full_name" VARCHAR(120),
    "license_number" VARCHAR(64),
    "license_expiry" DATE,
    "license_document_key" VARCHAR(512),
    "profile_image_key" VARCHAR(512),
    "emergency_contact_name" VARCHAR(120),
    "emergency_contact_phone" VARCHAR(20),
    "joined_on" DATE,
    "employment_status" "DriverEmploymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "availability" "DriverAvailability" NOT NULL DEFAULT 'OFFLINE',
    "notes" VARCHAR(2000),
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "vehicle_number" VARCHAR(32) NOT NULL,
    "registration_number" VARCHAR(24) NOT NULL,
    "make_model" VARCHAR(120),
    "tank_capacity" DECIMAL(12,3) NOT NULL,
    "compartment_count" INTEGER NOT NULL DEFAULT 1,
    "peso_license_number" VARCHAR(64),
    "peso_license_expiry" DATE,
    "calibration_cert_number" VARCHAR(64),
    "calibration_expiry" DATE,
    "insurance_expiry" DATE,
    "puc_expiry" DATE,
    "fitness_expiry" DATE,
    "status" "VehicleStatus" NOT NULL DEFAULT 'ACTIVE',
    "retired_at" TIMESTAMPTZ(6),
    "retired_reason" VARCHAR(500),
    "notes" VARCHAR(2000),
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_inventory" (
    "vehicle_id" UUID NOT NULL,
    "current_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "held_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "last_source" "FuelStockSource" NOT NULL DEFAULT 'MANUAL',
    "last_verified_at" TIMESTAMPTZ(6),
    "stale_after" TIMESTAMPTZ(6),
    "version" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_inventory_pkey" PRIMARY KEY ("vehicle_id")
);

-- CreateTable
CREATE TABLE "inventory_adjustments" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "type" "InventoryAdjustmentType" NOT NULL,
    "quantity_delta" DECIMAL(12,3) NOT NULL,
    "quantity_before" DECIMAL(12,3) NOT NULL,
    "quantity_after" DECIMAL(12,3) NOT NULL,
    "reason_code" VARCHAR(64),
    "reason" VARCHAR(1000),
    "depot_name" VARCHAR(160),
    "invoice_ref" VARCHAR(64),
    "photo_key" VARCHAR(512),
    "occurred_at" TIMESTAMPTZ(6),
    "performed_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_assignments" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "driver_profile_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_user_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by_user_id" UUID,
    "release_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_shifts" (
    "id" UUID NOT NULL,
    "driver_profile_id" UUID NOT NULL,
    "driver_user_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'OPEN',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "opening_meter_reading_id" UUID,
    "closing_meter_reading_id" UUID,
    "opening_fuel_quantity" DECIMAL(12,3),
    "closing_fuel_quantity" DECIMAL(12,3),
    "last_latitude" DECIMAL(10,7),
    "last_longitude" DECIMAL(10,7),
    "last_location_at" TIMESTAMPTZ(6),
    "started_by_user_id" UUID,
    "ended_by_user_id" UUID,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "driver_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meter_readings" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "reading_type" "MeterReadingType" NOT NULL,
    "totalizer" DECIMAL(14,3) NOT NULL,
    "gross_quantity" DECIMAL(12,3),
    "net_quantity" DECIMAL(12,3),
    "temperature_c" DECIMAL(5,2),
    "source" "MeterReadingSource" NOT NULL DEFAULT 'MANUAL_ENTRY',
    "photo_key" VARCHAR(512),
    "recorded_by_user_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" VARCHAR(500),

    CONSTRAINT "meter_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_by" UUID,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_principal_key" ON "users"("phone", "principal");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_principal_key" ON "users"("email", "principal");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_refresh_token_hash_key" ON "user_sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "user_sessions_user_id_revoked_at_idx" ON "user_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "user_sessions_expires_at_idx" ON "user_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "user_sessions_absolute_expires_at_idx" ON "user_sessions"("absolute_expires_at");

-- CreateIndex
CREATE INDEX "otp_challenges_identifier_principal_purpose_created_at_idx" ON "otp_challenges"("identifier", "principal", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "otp_challenges_expires_at_idx" ON "otp_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_resource_idx" ON "permissions"("resource");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_user_id_key" ON "customer_profiles"("user_id");

-- CreateIndex
CREATE INDEX "addresses_user_id_archived_at_idx" ON "addresses"("user_id", "archived_at");

-- CreateIndex
CREATE INDEX "addresses_corporate_account_id_idx" ON "addresses"("corporate_account_id");

-- CreateIndex
CREATE INDEX "corporate_accounts_verification_status_created_at_idx" ON "corporate_accounts"("verification_status", "created_at");

-- CreateIndex
CREATE INDEX "corporate_accounts_account_status_idx" ON "corporate_accounts"("account_status");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_accounts_registration_id_type_registration_number_key" ON "corporate_accounts"("registration_id_type", "registration_number");

-- CreateIndex
CREATE INDEX "corporate_members_user_id_status_idx" ON "corporate_members"("user_id", "status");

-- CreateIndex
CREATE INDEX "corporate_members_corporate_account_id_status_idx" ON "corporate_members"("corporate_account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "corporate_members_corporate_account_id_user_id_key" ON "corporate_members"("corporate_account_id", "user_id");

-- CreateIndex
CREATE INDEX "corporate_verification_records_corporate_account_id_created_idx" ON "corporate_verification_records"("corporate_account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_user_id_key" ON "driver_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_profiles_employee_code_key" ON "driver_profiles"("employee_code");

-- CreateIndex
CREATE INDEX "driver_profiles_employment_status_license_expiry_idx" ON "driver_profiles"("employment_status", "license_expiry");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vehicle_number_key" ON "vehicles"("vehicle_number");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_registration_number_key" ON "vehicles"("registration_number");

-- CreateIndex
CREATE INDEX "vehicles_status_idx" ON "vehicles"("status");

-- CreateIndex
CREATE INDEX "vehicles_calibration_expiry_idx" ON "vehicles"("calibration_expiry");

-- CreateIndex
CREATE INDEX "vehicles_peso_license_expiry_idx" ON "vehicles"("peso_license_expiry");

-- CreateIndex
CREATE INDEX "inventory_adjustments_vehicle_id_created_at_idx" ON "inventory_adjustments"("vehicle_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_adjustments_type_created_at_idx" ON "inventory_adjustments"("type", "created_at");

-- CreateIndex
CREATE INDEX "vehicle_assignments_vehicle_id_released_at_idx" ON "vehicle_assignments"("vehicle_id", "released_at");

-- CreateIndex
CREATE INDEX "vehicle_assignments_driver_profile_id_released_at_idx" ON "vehicle_assignments"("driver_profile_id", "released_at");

-- CreateIndex
CREATE UNIQUE INDEX "driver_shifts_opening_meter_reading_id_key" ON "driver_shifts"("opening_meter_reading_id");

-- CreateIndex
CREATE UNIQUE INDEX "driver_shifts_closing_meter_reading_id_key" ON "driver_shifts"("closing_meter_reading_id");

-- CreateIndex
CREATE INDEX "driver_shifts_driver_profile_id_status_idx" ON "driver_shifts"("driver_profile_id", "status");

-- CreateIndex
CREATE INDEX "driver_shifts_vehicle_id_status_idx" ON "driver_shifts"("vehicle_id", "status");

-- CreateIndex
CREATE INDEX "driver_shifts_started_at_idx" ON "driver_shifts"("started_at");

-- CreateIndex
CREATE INDEX "meter_readings_vehicle_id_captured_at_idx" ON "meter_readings"("vehicle_id", "captured_at");

-- CreateIndex
CREATE INDEX "meter_readings_vehicle_id_reading_type_captured_at_idx" ON "meter_readings"("vehicle_id", "reading_type", "captured_at");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_corporate_account_id_fkey" FOREIGN KEY ("corporate_account_id") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_members" ADD CONSTRAINT "corporate_members_corporate_account_id_fkey" FOREIGN KEY ("corporate_account_id") REFERENCES "corporate_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_members" ADD CONSTRAINT "corporate_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corporate_verification_records" ADD CONSTRAINT "corporate_verification_records_corporate_account_id_fkey" FOREIGN KEY ("corporate_account_id") REFERENCES "corporate_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_profiles" ADD CONSTRAINT "driver_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inventory" ADD CONSTRAINT "vehicle_inventory_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_assignments" ADD CONSTRAINT "vehicle_assignments_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_driver_user_id_fkey" FOREIGN KEY ("driver_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_opening_meter_reading_id_fkey" FOREIGN KEY ("opening_meter_reading_id") REFERENCES "meter_readings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver_shifts" ADD CONSTRAINT "driver_shifts_closing_meter_reading_id_fkey" FOREIGN KEY ("closing_meter_reading_id") REFERENCES "meter_readings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints Prisma cannot express in schema.prisma.
--
-- Prisma has no CHECK support and does not introspect CHECK constraints, so
-- adding them here does NOT cause migration drift: the shadow database built
-- from these migrations contains them too.
-- ---------------------------------------------------------------------------

-- Identity ------------------------------------------------------------------

ALTER TABLE "users"
  ADD CONSTRAINT "users_requires_phone_or_email"
  CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);

ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_rotation_counter_non_negative"
  CHECK ("rotation_counter" >= 0);

ALTER TABLE "user_sessions"
  ADD CONSTRAINT "user_sessions_expiry_within_absolute"
  CHECK ("expires_at" <= "absolute_expires_at");

ALTER TABLE "otp_challenges"
  ADD CONSTRAINT "otp_challenges_attempts_within_max"
  CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts");

ALTER TABLE "otp_challenges"
  ADD CONSTRAINT "otp_challenges_resend_count_non_negative"
  CHECK ("resend_count" >= 0);

-- Addresses -----------------------------------------------------------------

ALTER TABLE "addresses"
  ADD CONSTRAINT "addresses_latitude_range"
  CHECK ("latitude" >= -90 AND "latitude" <= 90);

ALTER TABLE "addresses"
  ADD CONSTRAINT "addresses_longitude_range"
  CHECK ("longitude" >= -180 AND "longitude" <= 180);

CREATE UNIQUE INDEX "addresses_one_default_per_user"
  ON "addresses" ("user_id")
  WHERE "is_default" AND "archived_at" IS NULL;

-- Corporate -----------------------------------------------------------------

ALTER TABLE "corporate_members"
  ADD CONSTRAINT "corporate_members_removal_consistent"
  CHECK (
    ("status" = 'ACTIVE'  AND "removed_at" IS NULL) OR
    ("status" = 'REMOVED' AND "removed_at" IS NOT NULL)
  );

CREATE UNIQUE INDEX "corporate_members_one_active_owner"
  ON "corporate_members" ("corporate_account_id")
  WHERE "role" = 'CORPORATE_OWNER' AND "status" = 'ACTIVE';

ALTER TABLE "corporate_verification_records"
  ADD CONSTRAINT "corporate_verification_rejection_has_reason"
  CHECK (
    "to_status" <> 'REJECTED' OR
    ("reason_code" IS NOT NULL AND "applicant_note" IS NOT NULL)
  );

-- Fleet: vehicles and inventory ---------------------------------------------

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_tank_capacity_positive"
  CHECK ("tank_capacity" > 0);

ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_compartment_count_positive"
  CHECK ("compartment_count" >= 1);

-- A retired vehicle must record when. Keeps the soft-delete pair honest.
ALTER TABLE "vehicles"
  ADD CONSTRAINT "vehicles_retirement_consistent"
  CHECK (
    ("status" =  'RETIRED' AND "retired_at" IS NOT NULL) OR
    ("status" <> 'RETIRED' AND "retired_at" IS NULL)
  );

-- Stock can never be negative, and never more than is promised away. These are
-- the invariants dispatch will rely on when it reserves fuel (INV-03).
ALTER TABLE "vehicle_inventory"
  ADD CONSTRAINT "vehicle_inventory_quantities_non_negative"
  CHECK ("current_quantity" >= 0 AND "held_quantity" >= 0);

ALTER TABLE "vehicle_inventory"
  ADD CONSTRAINT "vehicle_inventory_held_within_current"
  CHECK ("held_quantity" <= "current_quantity");

-- The adjustment log must be arithmetically self-consistent: a row claiming a
-- before/after pair that does not match its own delta is corrupt, and would
-- silently break the reconciliation that compares the log against the cache.
ALTER TABLE "inventory_adjustments"
  ADD CONSTRAINT "inventory_adjustments_arithmetic"
  CHECK ("quantity_after" = "quantity_before" + "quantity_delta");

ALTER TABLE "inventory_adjustments"
  ADD CONSTRAINT "inventory_adjustments_resulting_quantity_non_negative"
  CHECK ("quantity_after" >= 0);

-- A manual correction MUST be explained. This is the movement that can conceal
-- theft, so the requirement is structural rather than merely validated.
ALTER TABLE "inventory_adjustments"
  ADD CONSTRAINT "inventory_adjustments_manual_requires_reason"
  CHECK (
    "type" NOT IN ('MANUAL_INCREASE', 'MANUAL_DECREASE') OR
    ("reason_code" IS NOT NULL AND "reason" IS NOT NULL)
  );

-- Direction must match the type, so a "refill" cannot remove fuel.
ALTER TABLE "inventory_adjustments"
  ADD CONSTRAINT "inventory_adjustments_direction_matches_type"
  CHECK (
    ("type" = 'REFILL'          AND "quantity_delta" > 0) OR
    ("type" = 'MANUAL_INCREASE' AND "quantity_delta" > 0) OR
    ("type" = 'MANUAL_DECREASE' AND "quantity_delta" < 0) OR
    ("type" = 'DISPENSED'       AND "quantity_delta" < 0) OR
    ("type" = 'OPENING_BALANCE' AND "quantity_delta" >= 0)
  );

-- Fleet: assignments --------------------------------------------------------

-- THE TWO EXCLUSIVITY RULES. The service checks these first for a good error
-- message; these indexes are what make a concurrent double-assign impossible
-- rather than merely unlikely.
CREATE UNIQUE INDEX "vehicle_assignments_one_active_per_vehicle"
  ON "vehicle_assignments" ("vehicle_id")
  WHERE "released_at" IS NULL;

CREATE UNIQUE INDEX "vehicle_assignments_one_active_per_driver"
  ON "vehicle_assignments" ("driver_profile_id")
  WHERE "released_at" IS NULL;

ALTER TABLE "vehicle_assignments"
  ADD CONSTRAINT "vehicle_assignments_released_after_assigned"
  CHECK ("released_at" IS NULL OR "released_at" >= "assigned_at");

-- Fleet: shifts -------------------------------------------------------------

-- INV-07: at most one open shift per driver, and one per vehicle.
CREATE UNIQUE INDEX "driver_shifts_one_open_per_driver"
  ON "driver_shifts" ("driver_profile_id")
  WHERE "status" = 'OPEN';

CREATE UNIQUE INDEX "driver_shifts_one_open_per_vehicle"
  ON "driver_shifts" ("vehicle_id")
  WHERE "status" = 'OPEN';

ALTER TABLE "driver_shifts"
  ADD CONSTRAINT "driver_shifts_closure_consistent"
  CHECK (
    ("status" = 'OPEN'   AND "ended_at" IS NULL) OR
    ("status" = 'CLOSED' AND "ended_at" IS NOT NULL)
  );

ALTER TABLE "driver_shifts"
  ADD CONSTRAINT "driver_shifts_ended_after_started"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- Fleet: meter readings -----------------------------------------------------

-- A totaliser is a lifetime counter; a negative one is not a reading.
ALTER TABLE "meter_readings"
  ADD CONSTRAINT "meter_readings_totalizer_non_negative"
  CHECK ("totalizer" >= 0);

-- BR-906: a manual entry without a photograph is an unevidenced claim.
ALTER TABLE "meter_readings"
  ADD CONSTRAINT "meter_readings_manual_requires_photo"
  CHECK ("source" <> 'MANUAL_ENTRY' OR "photo_key" IS NOT NULL);
