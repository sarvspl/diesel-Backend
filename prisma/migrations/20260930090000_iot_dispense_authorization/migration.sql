-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "iot_device_id" VARCHAR(32);

-- CreateTable
CREATE TABLE "iot_dispense_authorizations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "device_id" VARCHAR(32) NOT NULL,
    "vehicle_registration" VARCHAR(24) NOT NULL,
    "authorized_litres" INTEGER NOT NULL,
    "request_ref" VARCHAR(32) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "iot_transaction_id" VARCHAR(64),
    "mpin" VARCHAR(16),
    "error_message" VARCHAR(500),
    "raw" JSONB,
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "iot_dispense_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "iot_dispense_authorizations_order_id_created_at_idx" ON "iot_dispense_authorizations"("order_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_iot_device_id_key" ON "vehicles"("iot_device_id");

-- AddForeignKey
ALTER TABLE "iot_dispense_authorizations" ADD CONSTRAINT "iot_dispense_authorizations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iot_dispense_authorizations" ADD CONSTRAINT "iot_dispense_authorizations_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
