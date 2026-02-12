-- CreateEnum
CREATE TYPE "SupportPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- AlterTable: Add new fields to drivers
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "ratingCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "totalOnlineSeconds" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "lastOnlineAt" TIMESTAMP(3);
ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: Add per-ride rating and cancelledBy to rides
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "passengerRating" INTEGER;
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "passengerFeedback" TEXT;
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "ratedByPassengerAt" TIMESTAMP(3);
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "driverRating" INTEGER;
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "driverFeedback" TEXT;
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "ratedByDriverAt" TIMESTAMP(3);
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "cancelledBy" TEXT;
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "surgeFare" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable: Add fare breakdown and commission rate to driver_earnings
ALTER TABLE "driver_earnings" ADD COLUMN IF NOT EXISTS "commissionRate" DOUBLE PRECISION NOT NULL DEFAULT 0.20;
ALTER TABLE "driver_earnings" ADD COLUMN IF NOT EXISTS "baseFare" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "driver_earnings" ADD COLUMN IF NOT EXISTS "distanceFare" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "driver_earnings" ADD COLUMN IF NOT EXISTS "timeFare" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "driver_earnings" ADD COLUMN IF NOT EXISTS "surgeFare" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable: SavedPlace
CREATE TABLE IF NOT EXISTS "saved_places" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "placeType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_places_pkey" PRIMARY KEY ("id")
);

-- CreateTable: SupportTicket
CREATE TABLE IF NOT EXISTS "support_tickets" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "driverId" TEXT,
    "issueType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "SupportPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "response" TEXT,
    "respondedAt" TIMESTAMP(3),
    "respondedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable: PlatformConfig
CREATE TABLE IF NOT EXISTS "platform_config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "platform_config_key_key" ON "platform_config"("key");

-- AddForeignKey
ALTER TABLE "saved_places" ADD CONSTRAINT "saved_places_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default platform config
INSERT INTO "platform_config" ("id", "key", "value", "description", "updatedAt")
VALUES 
  (gen_random_uuid()::text, 'platform_fee_rate', '0.20', 'Default platform commission rate (20%)', NOW()),
  (gen_random_uuid()::text, 'earnings_window_type', 'calendar', 'Options: calendar, rolling_24h', NOW())
ON CONFLICT ("key") DO NOTHING;
