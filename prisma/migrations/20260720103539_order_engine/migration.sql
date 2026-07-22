-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'PAYMENT_FAILED', 'CONFIRMED', 'ALLOCATING', 'ALLOCATION_FAILED', 'ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'DISPENSING', 'DELIVERED', 'PARTIALLY_DELIVERED', 'DELIVERY_FAILED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_ADMIN', 'EXPIRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'SETTLED', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SETTLED');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('PREPAID_ONLINE', 'WALLET', 'CASH_ON_DELIVERY', 'CORPORATE_CREDIT');

-- CreateEnum
CREATE TYPE "ActorKind" AS ENUM ('CUSTOMER', 'DRIVER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('HELD', 'CONSUMED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "order_number" VARCHAR(32) NOT NULL,
    "user_id" UUID NOT NULL,
    "corporate_account_id" UUID,
    "corporate_member_id" UUID,
    "quote_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "delivered_quantity" DECIMAL(12,3),
    "fuel_amount" DECIMAL(14,2) NOT NULL,
    "delivery_amount" DECIMAL(14,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "final_total_amount" DECIMAL(14,2),
    "customer_snapshot" JSONB NOT NULL,
    "address_snapshot" JSONB NOT NULL,
    "product_snapshot" JSONB NOT NULL,
    "pricing_snapshot" JSONB NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'DRAFT',
    "payment_status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "settlement_status" "SettlementStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "payment_mode" "PaymentMode" NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_user_id" UUID,
    "cancelled_by_kind" "ActorKind",
    "cancellation_reason" VARCHAR(1000),
    "city" VARCHAR(120) NOT NULL,
    "state" VARCHAR(120),
    "delivery_instructions" VARCHAR(500),
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_events" (
    "id" BIGSERIAL NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "OrderStatus",
    "to_status" "OrderStatus" NOT NULL,
    "actor_kind" "ActorKind" NOT NULL,
    "actor_user_id" UUID,
    "reason" VARCHAR(1000),
    "metadata" JSONB,
    "request_id" VARCHAR(64),
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fuel_reservations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'HELD',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "release_reason" VARCHAR(64),
    "consumed_quantity" DECIMAL(12,3),
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fuel_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "state" "IdempotencyState" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "resource_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "event_type" VARCHAR(96) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_retry_at" TIMESTAMPTZ(6),
    "last_error" VARCHAR(2000),
    "processed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
CREATE UNIQUE INDEX "orders_quote_id_key" ON "orders"("quote_id");

-- CreateIndex
CREATE INDEX "orders_user_id_created_at_idx" ON "orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_corporate_account_id_created_at_idx" ON "orders"("corporate_account_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_status_changed_at_idx" ON "orders"("status", "status_changed_at");

-- CreateIndex
CREATE INDEX "orders_expires_at_idx" ON "orders"("expires_at");

-- CreateIndex
CREATE INDEX "order_status_events_order_id_occurred_at_idx" ON "order_status_events"("order_id", "occurred_at");

-- CreateIndex
CREATE INDEX "order_status_events_to_status_occurred_at_idx" ON "order_status_events"("to_status", "occurred_at");

-- CreateIndex
CREATE INDEX "fuel_reservations_vehicle_id_status_idx" ON "fuel_reservations"("vehicle_id", "status");

-- CreateIndex
CREATE INDEX "fuel_reservations_status_expires_at_idx" ON "fuel_reservations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_user_id_endpoint_key_key" ON "idempotency_keys"("user_id", "endpoint", "key");

-- CreateIndex
CREATE INDEX "outbox_events_status_next_retry_at_idx" ON "outbox_events"("status", "next_retry_at");

-- CreateIndex
CREATE INDEX "outbox_events_aggregate_aggregate_id_idx" ON "outbox_events"("aggregate", "aggregate_id");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_corporate_account_id_fkey" FOREIGN KEY ("corporate_account_id") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_corporate_member_id_fkey" FOREIGN KEY ("corporate_member_id") REFERENCES "corporate_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "fuel_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "fuel_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_reservations" ADD CONSTRAINT "fuel_reservations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fuel_reservations" ADD CONSTRAINT "fuel_reservations_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Constraints and indexes Prisma cannot express.
--
-- The service checks that mirror these exist to produce good error messages.
-- These exist to make the bad state unreachable - under concurrency, under a
-- careless migration, and under a direct UPDATE at a psql prompt.
-- ===========================================================================

-- Orders: integrity ---------------------------------------------------------

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_delivered_quantity_non_negative"
  CHECK ("delivered_quantity" IS NULL OR "delivered_quantity" >= 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_non_negative"
  CHECK (
    "fuel_amount" >= 0 AND
    "delivery_amount" >= 0 AND
    "tax_amount" >= 0 AND
    "total_amount" >= 0 AND
    ("final_total_amount" IS NULL OR "final_total_amount" >= 0)
  );

/*
 * INV-09 applied to the order, and the same asymmetry the quote carries:
 * total = fuel + delivery, with tax DELIBERATELY absent from the sum.
 *
 * The fuel line is tax-INCLUSIVE - Indian diesel is quoted at a pump rate that
 * already contains VAT and excise - so adding tax_amount again would charge it
 * twice. This is the single easiest thing to get wrong in this domain, which is
 * why it is pinned here rather than left to the code that copied it.
 */
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_total_equals_lines"
  CHECK ("total_amount" = "fuel_amount" + "delivery_amount");

-- BR-1206: an unexplained cancellation is a support call nobody can answer.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_cancellation_has_a_reason"
  CHECK (
    "cancelled_at" IS NULL OR
    ("cancellation_reason" IS NOT NULL AND "cancelled_by_kind" IS NOT NULL)
  );

-- A cancelled timestamp with a live status, or a cancelled status with no
-- timestamp, are both states no code path should be able to produce.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_cancelled_states_are_consistent"
  CHECK (
    ("status" IN ('CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_ADMIN', 'EXPIRED'))
      = ("cancelled_at" IS NOT NULL)
  );

-- Orders: the dispatch board ------------------------------------------------

/*
 * THE HIGHEST-LEVERAGE INDEX IN THIS MODULE (docs/08 section 10.1).
 *
 * Open orders are a tiny fraction of the table and STAY tiny while history
 * grows without bound. A full index on status would carry every closed order
 * forever to answer a question only ever asked about live ones.
 */
CREATE INDEX "orders_open_board"
  ON "orders" ("status", "status_changed_at")
  WHERE "status" NOT IN ('CLOSED', 'CANCELLED_BY_CUSTOMER', 'CANCELLED_BY_ADMIN', 'EXPIRED');

-- The expiry sweep (BR-1006). Same reasoning: only unpaid orders can lapse.
CREATE INDEX "orders_pending_expiry"
  ON "orders" ("expires_at")
  WHERE "status" IN ('DRAFT', 'PENDING_PAYMENT', 'PAYMENT_FAILED');

-- BR-804 soft duplicate lookup: one customer, one address, recent.
CREATE INDEX "orders_duplicate_probe"
  ON "orders" ("user_id", "address_id", "created_at" DESC);

-- Orders: FROZEN FINANCIAL SNAPSHOTS ----------------------------------------

/*
 * "These snapshots must never change."
 *
 * Stated as a business rule, so it is enforced as one. A trigger rather than a
 * convention, because the convention is one careless migration, one support
 * script or one well-meaning UPDATE away from being bypassed - and by the time
 * anyone notices, the evidence of what the customer actually agreed to is gone.
 *
 * The frozen set is: the quote it came from, the price version, the ordered
 * quantity, the four estimated amounts, and all four snapshot documents.
 *
 * NOT frozen, deliberately: delivered_quantity and final_total_amount. Those
 * are what reconciliation writes, and they are the whole reason the estimated
 * figures had to be frozen separately (ADR-009).
 */
CREATE OR REPLACE FUNCTION orders_reject_snapshot_changes()
RETURNS TRIGGER AS $fn$
BEGIN
  IF NEW.quote_id          IS DISTINCT FROM OLD.quote_id
  OR NEW.price_id          IS DISTINCT FROM OLD.price_id
  OR NEW.product_id        IS DISTINCT FROM OLD.product_id
  OR NEW.order_number      IS DISTINCT FROM OLD.order_number
  OR NEW.quantity          IS DISTINCT FROM OLD.quantity
  OR NEW.fuel_amount       IS DISTINCT FROM OLD.fuel_amount
  OR NEW.delivery_amount   IS DISTINCT FROM OLD.delivery_amount
  OR NEW.tax_amount        IS DISTINCT FROM OLD.tax_amount
  OR NEW.total_amount      IS DISTINCT FROM OLD.total_amount
  OR NEW.customer_snapshot IS DISTINCT FROM OLD.customer_snapshot
  OR NEW.address_snapshot  IS DISTINCT FROM OLD.address_snapshot
  OR NEW.product_snapshot  IS DISTINCT FROM OLD.product_snapshot
  OR NEW.pricing_snapshot  IS DISTINCT FROM OLD.pricing_snapshot
  THEN
    RAISE EXCEPTION
      'Order % carries immutable financial snapshots; they cannot be changed after placement', OLD.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER orders_snapshots_are_immutable
  BEFORE UPDATE ON "orders"
  FOR EACH ROW EXECUTE FUNCTION orders_reject_snapshot_changes();

-- Order status events: APPEND-ONLY ------------------------------------------

/*
 * docs/08 section 1.2: append-only, "enforced at the database privilege level
 * rather than by application convention. An application-level rule is one
 * careless migration away from being bypassed."
 *
 * Revoking UPDATE and DELETE is the privilege-level half and belongs in the
 * role grants, which this project does not manage yet (the application connects
 * as the owner). A trigger is the half that works regardless of who connects,
 * and it is what makes the timeline trustworthy as evidence.
 */
CREATE OR REPLACE FUNCTION order_status_events_reject_mutation()
RETURNS TRIGGER AS $fn$
BEGIN
  RAISE EXCEPTION
    'order_status_events is append-only: the order timeline is evidence and is never edited'
    USING ERRCODE = '23514';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER order_status_events_no_update
  BEFORE UPDATE ON "order_status_events"
  FOR EACH ROW EXECUTE FUNCTION order_status_events_reject_mutation();

CREATE TRIGGER order_status_events_no_delete
  BEFORE DELETE ON "order_status_events"
  FOR EACH ROW EXECUTE FUNCTION order_status_events_reject_mutation();

-- A human transition with no human attached is not auditable; a SYSTEM one
-- with a user attached is a lie about who acted (docs/03 section 5).
ALTER TABLE "order_status_events"
  ADD CONSTRAINT "order_status_events_actor_matches_kind"
  CHECK (
    ("actor_kind" = 'SYSTEM' AND "actor_user_id" IS NULL) OR
    ("actor_kind" <> 'SYSTEM' AND "actor_user_id" IS NOT NULL)
  );

-- A transition to the state it is already in is not a transition.
ALTER TABLE "order_status_events"
  ADD CONSTRAINT "order_status_events_actually_changed"
  CHECK ("from_status" IS NULL OR "from_status" <> "to_status");

-- Fuel reservations ---------------------------------------------------------

ALTER TABLE "fuel_reservations"
  ADD CONSTRAINT "fuel_reservations_quantity_positive"
  CHECK ("quantity" > 0);

ALTER TABLE "fuel_reservations"
  ADD CONSTRAINT "fuel_reservations_consumed_non_negative"
  CHECK ("consumed_quantity" IS NULL OR "consumed_quantity" >= 0);

/*
 * INV-06: "An order has at most one active fuel reservation."
 *
 * A partial unique index is the physical form of that sentence. Without it, a
 * retried reserve call double-counts held_quantity and the tanker reports less
 * free capacity than it has - which strands orders that could have been served.
 */
CREATE UNIQUE INDEX "fuel_reservations_one_active_per_order"
  ON "fuel_reservations" ("order_id")
  WHERE "status" = 'HELD';

-- The expiry sweep (BR-407). Held rows are a tiny, permanently tiny subset.
CREATE INDEX "fuel_reservations_expiry_sweep"
  ON "fuel_reservations" ("expires_at")
  WHERE "status" = 'HELD';

-- Leaving HELD is what sets these; being HELD is what leaves them null.
ALTER TABLE "fuel_reservations"
  ADD CONSTRAINT "fuel_reservations_release_is_consistent"
  CHECK (
    ("status" = 'HELD' AND "released_at" IS NULL) OR
    ("status" <> 'HELD' AND "released_at" IS NOT NULL)
  );

-- Vehicle inventory: INV-03 -------------------------------------------------
--
-- "For any vehicle: held >= 0, available >= 0" is ALREADY enforced by
-- `vehicle_inventory_quantities_non_negative`, added with the fleet module.
-- Nothing to add here: this module is the first thing to write held_quantity,
-- and the constraint that guards it was written before there was anything to
-- guard against.

-- Idempotency ---------------------------------------------------------------

-- A completed record without a response cannot be replayed, which defeats the
-- entire mechanism (docs/10 section 8.2).
ALTER TABLE "idempotency_keys"
  ADD CONSTRAINT "idempotency_keys_completed_has_a_response"
  CHECK ("state" <> 'COMPLETED' OR "response_status" IS NOT NULL);

-- Outbox --------------------------------------------------------------------

-- The drainer's read. Done rows grow without bound; pending rows do not.
CREATE INDEX "outbox_events_pending"
  ON "outbox_events" ("next_retry_at", "created_at")
  WHERE "status" IN ('PENDING', 'FAILED');
