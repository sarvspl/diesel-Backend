-- AlterTable
ALTER TABLE "meter_readings" ADD COLUMN     "stock_litres" DECIMAL(12,3),
ALTER COLUMN "totalizer" DROP NOT NULL;

-- Stock is non-negative (a CHECK passes when the value is NULL, i.e. a meter reading).
ALTER TABLE "meter_readings"
  ADD CONSTRAINT "meter_readings_stock_non_negative"
  CHECK ("stock_litres" IS NULL OR "stock_litres" >= 0);

-- A reading carries EXACTLY ONE of totalizer / stock_litres. Meter readings set
-- the first, bowser-monitor readings the second; neither-nor-both is a bug.
ALTER TABLE "meter_readings"
  ADD CONSTRAINT "meter_readings_value_exactly_one"
  CHECK (("totalizer" IS NOT NULL)::int + ("stock_litres" IS NOT NULL)::int = 1);
