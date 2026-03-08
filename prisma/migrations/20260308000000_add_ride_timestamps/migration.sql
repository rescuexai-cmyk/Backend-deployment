-- Add driverAssignedAt and driverArrivedAt to rides table
-- These columns track when driver was assigned and when they arrived at pickup

ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "driverAssignedAt" TIMESTAMP(3);
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "driverArrivedAt" TIMESTAMP(3);
