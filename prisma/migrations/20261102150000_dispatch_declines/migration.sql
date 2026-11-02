-- CreateTable
CREATE TABLE "dispatch_declines" (
    "order_id" UUID NOT NULL,
    "driver_profile_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_declines_pkey" PRIMARY KEY ("order_id","driver_profile_id")
);

-- CreateIndex
CREATE INDEX "dispatch_declines_driver_profile_id_idx" ON "dispatch_declines"("driver_profile_id");

-- AddForeignKey
ALTER TABLE "dispatch_declines" ADD CONSTRAINT "dispatch_declines_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_declines" ADD CONSTRAINT "dispatch_declines_driver_profile_id_fkey" FOREIGN KEY ("driver_profile_id") REFERENCES "driver_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
