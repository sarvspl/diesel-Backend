-- AlterTable
ALTER TABLE "fuel_prices" ADD COLUMN     "pincode" VARCHAR(6),
ALTER COLUMN "city" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "fuel_prices_product_id_pincode_status_effective_from_idx" ON "fuel_prices"("product_id", "pincode", "status", "effective_from");
