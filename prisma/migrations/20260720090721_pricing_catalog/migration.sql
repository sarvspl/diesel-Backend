-- CreateEnum
CREATE TYPE "FuelUnit" AS ENUM ('LITRE', 'KILOGRAM');

-- CreateEnum
CREATE TYPE "CatalogStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "PriceStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'SUPERSEDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('VAT_EXCISE', 'GST', 'EXEMPT');

-- CreateEnum
CREATE TYPE "TaxCalculationType" AS ENUM ('PERCENTAGE', 'PER_UNIT');

-- CreateEnum
CREATE TYPE "TaxAppliesTo" AS ENUM ('FUEL', 'DELIVERY');

-- CreateEnum
CREATE TYPE "DeliveryChargeType" AS ENUM ('FLAT', 'DISTANCE_BASED', 'ZONE_BASED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'CONSUMED');

-- CreateTable
CREATE TABLE "fuel_products" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(1000),
    "unit" "FuelUnit" NOT NULL DEFAULT 'LITRE',
    "hsn_code" VARCHAR(16),
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fuel_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_prices" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "price_per_unit" DECIMAL(14,4) NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_until" TIMESTAMPTZ(6),
    "status" "PriceStatus" NOT NULL DEFAULT 'ACTIVE',
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "change_percent" DECIMAL(8,4),
    "superseded_by_id" UUID,
    "notes" VARCHAR(1000),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fuel_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_rules" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "regime" "TaxRegime" NOT NULL,
    "applies_to" "TaxAppliesTo" NOT NULL,
    "calculation_type" "TaxCalculationType" NOT NULL DEFAULT 'PERCENTAGE',
    "rate" DECIMAL(12,4) NOT NULL,
    "is_inclusive" BOOLEAN NOT NULL DEFAULT false,
    "state" VARCHAR(120),
    "sac_code" VARCHAR(16),
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_until" TIMESTAMPTZ(6),
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tax_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_charge_rules" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "charge_type" "DeliveryChargeType" NOT NULL DEFAULT 'FLAT',
    "city" VARCHAR(120),
    "flat_charge" DECIMAL(14,2) NOT NULL,
    "min_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "max_quantity" DECIMAL(12,3),
    "minimum_order_quantity" DECIMAL(12,3),
    "free_above_order_value" DECIMAL(14,2),
    "sac_code" VARCHAR(16),
    "priority" INTEGER NOT NULL DEFAULT 100,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_until" TIMESTAMPTZ(6),
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_charge_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "fuel_amount" DECIMAL(14,2) NOT NULL,
    "delivery_amount" DECIMAL(14,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "state" VARCHAR(120),
    "status" "QuoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fuel_products_code_key" ON "fuel_products"("code");

-- CreateIndex
CREATE INDEX "fuel_products_status_display_order_idx" ON "fuel_products"("status", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "fuel_prices_superseded_by_id_key" ON "fuel_prices"("superseded_by_id");

-- CreateIndex
CREATE INDEX "fuel_prices_product_id_city_status_effective_from_idx" ON "fuel_prices"("product_id", "city", "status", "effective_from");

-- CreateIndex
CREATE INDEX "fuel_prices_effective_from_idx" ON "fuel_prices"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "tax_rules_code_key" ON "tax_rules"("code");

-- CreateIndex
CREATE INDEX "tax_rules_applies_to_status_effective_from_idx" ON "tax_rules"("applies_to", "status", "effective_from");

-- CreateIndex
CREATE INDEX "delivery_charge_rules_status_city_priority_idx" ON "delivery_charge_rules"("status", "city", "priority");

-- CreateIndex
CREATE INDEX "quotes_user_id_created_at_idx" ON "quotes"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_expires_at_idx" ON "quotes"("expires_at");

-- CreateIndex
CREATE INDEX "quotes_status_expires_at_idx" ON "quotes"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "fuel_prices" ADD CONSTRAINT "fuel_prices_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "fuel_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "fuel_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "fuel_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Constraints Prisma cannot express.
--
-- Everything below is written by hand because the Prisma schema language has
-- no syntax for CHECK constraints or EXCLUDE constraints. These are not
-- belt-and-braces duplicates of the service checks: the service checks exist
-- to produce a good error message, and these exist to make the bad state
-- unreachable even under concurrency, a bad migration or a manual UPDATE.
-- ===========================================================================

-- btree_gist lets a GiST index mix scalar equality (product_id, city) with a
-- range overlap operator in ONE exclusion constraint. Without it the range
-- part works but the equality part does not.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Pricing: the price timeline ----------------------------------------------

-- Fuel is sold, not given away, and a zero rate would also make the sanity
-- band undefined (it divides by the previous rate).
ALTER TABLE "fuel_prices"
  ADD CONSTRAINT "fuel_prices_rate_positive"
  CHECK ("price_per_unit" > 0);

-- Half-open window: [effective_from, effective_until). An empty or inverted
-- window is a price that was never in force.
ALTER TABLE "fuel_prices"
  ADD CONSTRAINT "fuel_prices_window_ordered"
  CHECK ("effective_until" IS NULL OR "effective_until" > "effective_from");

/*
 * BR-602, made IMPOSSIBLE BY CONSTRUCTION rather than merely checked.
 *
 * "Exactly one active price per product at any time." The service reads the
 * current price and then inserts, which is a textbook read-modify-write race:
 * two administrators publishing simultaneously would both see one active price
 * and both insert, leaving two live rates and a quote engine whose answer
 * depends on row order.
 *
 * This is the guarantee. Overlapping [from, until) windows for the same
 * product and city cannot both be ACTIVE - the second transaction blocks and
 * then fails, rather than corrupting the timeline.
 *
 * Partial on ACTIVE deliberately: DRAFT and PENDING_APPROVAL rows are proposals
 * that must be allowed to sit alongside the live rate, and SUPERSEDED rows are
 * history whose closed windows abut the current one.
 */
ALTER TABLE "fuel_prices"
  ADD CONSTRAINT "fuel_prices_no_overlapping_active_window"
  EXCLUDE USING gist (
    "product_id" WITH =,
    "city" WITH =,
    (tstzrange("effective_from", "effective_until", '[)')) WITH &&
  )
  WHERE ("status" = 'ACTIVE');

-- An approval is a fact with a time. Half of one is an audit trail nobody can
-- rely on.
ALTER TABLE "fuel_prices"
  ADD CONSTRAINT "fuel_prices_approval_complete"
  CHECK (
    ("approved_by_user_id" IS NULL     AND "approved_at" IS NULL) OR
    ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)
  );

-- SEPARATION OF DUTIES (BR-607), enforced at the lowest possible level. The
-- service refuses self-approval; this makes it unreachable even if that check
-- were removed or bypassed.
ALTER TABLE "fuel_prices"
  ADD CONSTRAINT "fuel_prices_approver_is_not_author"
  CHECK ("approved_by_user_id" IS NULL OR "approved_by_user_id" <> "created_by_user_id");

-- An out-of-band price cannot be live without someone having approved it.
ALTER TABLE "fuel_prices"
  ADD CONSTRAINT "fuel_prices_out_of_band_requires_approval"
  CHECK (
    "requires_approval" = false OR
    "status" <> 'ACTIVE' OR
    "approved_by_user_id" IS NOT NULL
  );

-- Superseding is what closes a window. A superseded row with an open end would
-- leave two rows claiming the same instant.
ALTER TABLE "fuel_prices"
  ADD CONSTRAINT "fuel_prices_superseded_window_closed"
  CHECK ("status" <> 'SUPERSEDED' OR "effective_until" IS NOT NULL);

-- Pricing: tax rules --------------------------------------------------------

ALTER TABLE "tax_rules"
  ADD CONSTRAINT "tax_rules_rate_non_negative"
  CHECK ("rate" >= 0);

-- A percentage above 100 is a data-entry error every time. A PER_UNIT rate is
-- an amount per litre and is deliberately not capped here.
ALTER TABLE "tax_rules"
  ADD CONSTRAINT "tax_rules_percentage_within_range"
  CHECK ("calculation_type" <> 'PERCENTAGE' OR "rate" <= 100);

ALTER TABLE "tax_rules"
  ADD CONSTRAINT "tax_rules_window_ordered"
  CHECK ("effective_until" IS NULL OR "effective_until" > "effective_from");

-- An exempt rule that charges something is a contradiction, and it would be
-- applied silently by the engine.
ALTER TABLE "tax_rules"
  ADD CONSTRAINT "tax_rules_exempt_is_zero"
  CHECK ("regime" <> 'EXEMPT' OR "rate" = 0);

-- Pricing: delivery charges -------------------------------------------------

ALTER TABLE "delivery_charge_rules"
  ADD CONSTRAINT "delivery_charge_rules_amounts_non_negative"
  CHECK (
    "flat_charge" >= 0 AND
    "min_quantity" >= 0 AND
    ("max_quantity" IS NULL OR "max_quantity" > "min_quantity") AND
    ("minimum_order_quantity" IS NULL OR "minimum_order_quantity" > 0) AND
    ("free_above_order_value" IS NULL OR "free_above_order_value" > 0)
  );

ALTER TABLE "delivery_charge_rules"
  ADD CONSTRAINT "delivery_charge_rules_window_ordered"
  CHECK ("effective_until" IS NULL OR "effective_until" > "effective_from");

-- Pricing: quotes -----------------------------------------------------------

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_amounts_non_negative"
  CHECK (
    "fuel_amount" >= 0 AND
    "delivery_amount" >= 0 AND
    "tax_amount" >= 0 AND
    "total_amount" >= 0
  );

/*
 * INV-09 as a database invariant.
 *
 * The total is the sum of the LINE totals. `tax_amount` is deliberately absent
 * from this sum: the fuel line is tax-INCLUSIVE, so its tax is already inside
 * `fuel_amount`, and adding it again would charge diesel VAT twice. That
 * asymmetry is the single easiest thing to get wrong in this domain, so it is
 * pinned here where no future change can quietly undo it.
 */
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_total_equals_lines"
  CHECK ("total_amount" = "fuel_amount" + "delivery_amount");

-- A quote with no expiry is an indefinite price lock (BR-604).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_expires_after_creation"
  CHECK ("expires_at" > "created_at");
