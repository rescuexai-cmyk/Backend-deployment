-- AlterTable: Add vehicleType to rides (bike_rescue, auto, cab_mini, cab_xl, cab_premium)
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "vehicleType" TEXT;
