-- Cross-zone vehicle permit rules + account soft-delete fields

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deletionReason" TEXT;

ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'SCAN_TO_PAY';

CREATE TABLE IF NOT EXISTS "cross_zone_rules" (
    "id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "vehicleType" TEXT NOT NULL,
    "isAllowed" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cross_zone_rules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "cross_zone_rules_origin_destination_vehicleType_key"
  ON "cross_zone_rules"("origin", "destination", "vehicleType");

CREATE INDEX IF NOT EXISTS "cross_zone_rules_origin_destination_idx"
  ON "cross_zone_rules"("origin", "destination");
