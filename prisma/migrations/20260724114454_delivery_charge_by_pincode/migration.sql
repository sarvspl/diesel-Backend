-- AlterTable
ALTER TABLE "delivery_charge_rules" ADD COLUMN     "pincode" VARCHAR(6);

-- CreateIndex
CREATE INDEX "delivery_charge_rules_status_pincode_priority_idx" ON "delivery_charge_rules"("status", "pincode", "priority");
