-- Add geo-targeting fields to Notification model
ALTER TABLE "notifications" ADD COLUMN "targetLatitude" DOUBLE PRECISION;
ALTER TABLE "notifications" ADD COLUMN "targetLongitude" DOUBLE PRECISION;
ALTER TABLE "notifications" ADD COLUMN "targetRadius" DOUBLE PRECISION;

-- Create index for geo-targeted notification queries
CREATE INDEX "notifications_targetLatitude_targetLongitude_idx" ON "notifications"("targetLatitude", "targetLongitude");

-- Add last known location fields to User model
ALTER TABLE "users" ADD COLUMN "lastLatitude" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN "lastLongitude" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN "lastLocationAt" TIMESTAMP(3);

-- Create index for user location queries (for geo-tagged notifications)
CREATE INDEX "users_lastLatitude_lastLongitude_idx" ON "users"("lastLatitude", "lastLongitude");
