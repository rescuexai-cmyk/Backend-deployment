-- Migration: add_rescue_screen_fields
-- Adds fields for all 11 rescue frontend screens

-- ============================================================================
-- 1. Add new columns to rescue_requests table
-- ============================================================================

-- Screen ① — Rescue Service Type
DO $$ BEGIN
  CREATE TYPE "RescueServiceType" AS ENUM (
    'TRAFFIC_RESCUE',
    'VEHICLE_RESCUE',
    'PASSENGER_VEHICLE_RESCUE',
    'BREAKDOWN_RESCUE',
    'EMERGENCY_ASSISTANCE'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "rescue_requests"
  ADD COLUMN IF NOT EXISTS "rescueServiceType" "RescueServiceType" NOT NULL DEFAULT 'PASSENGER_VEHICLE_RESCUE';

-- Screen ② — What's Happening
ALTER TABLE "rescue_requests"
  ADD COLUMN IF NOT EXISTS "reason" TEXT,
  ADD COLUMN IF NOT EXISTS "reasonDetails" TEXT;

-- Screen ③ — Is vehicle with user
ALTER TABLE "rescue_requests"
  ADD COLUMN IF NOT EXISTS "isVehicleWithUser" BOOLEAN NOT NULL DEFAULT true;

-- Screen ④ — Vehicle details
ALTER TABLE "rescue_requests"
  ADD COLUMN IF NOT EXISTS "vehicleSubType" TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleRegistrationNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleRegistrationState" TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleTransmission" TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleIssues" TEXT[] DEFAULT '{}';

-- Screen ⑥ — Fare estimates
ALTER TABLE "rescue_requests"
  ADD COLUMN IF NOT EXISTS "estimatedPassengerFare" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimatedVehicleFare" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimatedPlatformFee" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimatedInsuranceFee" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "estimatedTotalFare" DOUBLE PRECISION;

-- Screen ⑨ — SOS
ALTER TABLE "rescue_requests"
  ADD COLUMN IF NOT EXISTS "sosTriggered" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "sosTriggeredAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sosResolvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sosNotes" TEXT;

-- Screen ⑩ — Vehicle Delivery Verification
ALTER TABLE "rescue_requests"
  ADD COLUMN IF NOT EXISTS "vehicleDeliveryStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleConditionPhotos" TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "vehicleDeliveryNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "vehicleDeliveryAcceptedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "vehicleDeliveryIssue" TEXT;

-- Composite index for active rescue lookup
CREATE INDEX IF NOT EXISTS "rescue_requests_userId_status_idx"
  ON "rescue_requests"("userId", "status");

-- ============================================================================
-- 2. Create rescue_timeline_events table (Screen ⑨ Timeline Tab)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "rescue_timeline_events" (
  "id" TEXT NOT NULL,
  "rescueId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "actor" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rescue_timeline_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "rescue_timeline_events_rescueId_idx"
  ON "rescue_timeline_events"("rescueId");

CREATE INDEX IF NOT EXISTS "rescue_timeline_events_rescueId_createdAt_idx"
  ON "rescue_timeline_events"("rescueId", "createdAt");

ALTER TABLE "rescue_timeline_events"
  DROP CONSTRAINT IF EXISTS "rescue_timeline_events_rescueId_fkey";

ALTER TABLE "rescue_timeline_events"
  ADD CONSTRAINT "rescue_timeline_events_rescueId_fkey"
  FOREIGN KEY ("rescueId") REFERENCES "rescue_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 3. Create rescue_ratings table (Screen ⑪ Rating & Complete)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "rescue_ratings" (
  "id" TEXT NOT NULL,
  "rescueId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "rating" INTEGER NOT NULL,
  "feedback" VARCHAR(500),
  "problemSolved" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "rescue_ratings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "rescue_ratings_rescueId_userId_targetType_key"
  ON "rescue_ratings"("rescueId", "userId", "targetType");

CREATE INDEX IF NOT EXISTS "rescue_ratings_rescueId_idx"
  ON "rescue_ratings"("rescueId");

CREATE INDEX IF NOT EXISTS "rescue_ratings_targetId_idx"
  ON "rescue_ratings"("targetId");

ALTER TABLE "rescue_ratings"
  DROP CONSTRAINT IF EXISTS "rescue_ratings_rescueId_fkey";

ALTER TABLE "rescue_ratings"
  ADD CONSTRAINT "rescue_ratings_rescueId_fkey"
  FOREIGN KEY ("rescueId") REFERENCES "rescue_requests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 4. Seed default platform config values for rescue fees
-- ============================================================================

INSERT INTO "platform_config" ("id", "key", "value", "description", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'rescue_platform_fee', '20', 'Platform fee charged for rescue service (INR)', NOW()),
  (gen_random_uuid()::text, 'rescue_insurance_fee', '17', 'Insurance fee for rescue service (INR)', NOW())
ON CONFLICT ("key") DO NOTHING;
