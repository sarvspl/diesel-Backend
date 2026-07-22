-- DropIndex
DROP INDEX "orders_duplicate_probe";

-- AlterTable
ALTER TABLE "meter_readings" ADD COLUMN     "order_id" UUID;

-- AddForeignKey
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
