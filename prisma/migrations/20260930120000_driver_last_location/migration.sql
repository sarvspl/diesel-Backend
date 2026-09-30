-- AlterTable
ALTER TABLE "driver_profiles" ADD COLUMN     "last_latitude" DECIMAL(10,7),
ADD COLUMN     "last_location_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_longitude" DECIMAL(10,7);
