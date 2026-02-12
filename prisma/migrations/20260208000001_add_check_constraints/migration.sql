-- Migration: Add CHECK Constraints for Data Integrity
-- This migration adds database-level constraints that cannot be expressed in Prisma schema

-- ==================== SUPPORT TICKETS ====================
-- Constraint: A support ticket MUST have either userId OR driverId (at least one)
-- This ensures every ticket is linked to either a passenger or a driver

-- First, drop the constraint if it exists (idempotent)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'support_tickets_user_or_driver_check'
    ) THEN
        ALTER TABLE "support_tickets" DROP CONSTRAINT "support_tickets_user_or_driver_check";
    END IF;
END
$$;

-- Add the CHECK constraint
ALTER TABLE "support_tickets" 
ADD CONSTRAINT "support_tickets_user_or_driver_check" 
CHECK ("userId" IS NOT NULL OR "driverId" IS NOT NULL);

-- ==================== RIDES ====================
-- Constraint: passengerRating must be between 1 and 5 (inclusive) when not NULL
-- Constraint: driverRating must be between 1 and 5 (inclusive) when not NULL

-- Drop existing constraints if they exist (idempotent)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'rides_passenger_rating_range_check'
    ) THEN
        ALTER TABLE "rides" DROP CONSTRAINT "rides_passenger_rating_range_check";
    END IF;
    
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'rides_driver_rating_range_check'
    ) THEN
        ALTER TABLE "rides" DROP CONSTRAINT "rides_driver_rating_range_check";
    END IF;
END
$$;

-- Add rating range constraints
ALTER TABLE "rides" 
ADD CONSTRAINT "rides_passenger_rating_range_check" 
CHECK ("passengerRating" IS NULL OR ("passengerRating" >= 1 AND "passengerRating" <= 5));

ALTER TABLE "rides" 
ADD CONSTRAINT "rides_driver_rating_range_check" 
CHECK ("driverRating" IS NULL OR ("driverRating" >= 1 AND "driverRating" <= 5));

-- ==================== DRIVER EARNINGS ====================
-- Constraint: commission rate must be between 0 and 1 (0% to 100%)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'driver_earnings_commission_rate_check'
    ) THEN
        ALTER TABLE "driver_earnings" DROP CONSTRAINT "driver_earnings_commission_rate_check";
    END IF;
END
$$;

ALTER TABLE "driver_earnings" 
ADD CONSTRAINT "driver_earnings_commission_rate_check" 
CHECK ("commissionRate" >= 0 AND "commissionRate" <= 1);

-- ==================== DRIVERS ====================
-- Constraint: Driver rating must be between 0 and 5 when not NULL
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drivers_rating_range_check'
    ) THEN
        ALTER TABLE "drivers" DROP CONSTRAINT "drivers_rating_range_check";
    END IF;
END
$$;

ALTER TABLE "drivers" 
ADD CONSTRAINT "drivers_rating_range_check" 
CHECK ("rating" >= 0 AND "rating" <= 5);

-- Constraint: Latitude must be between -90 and 90
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drivers_latitude_range_check'
    ) THEN
        ALTER TABLE "drivers" DROP CONSTRAINT "drivers_latitude_range_check";
    END IF;
END
$$;

ALTER TABLE "drivers" 
ADD CONSTRAINT "drivers_latitude_range_check" 
CHECK ("currentLatitude" IS NULL OR ("currentLatitude" >= -90 AND "currentLatitude" <= 90));

-- Constraint: Longitude must be between -180 and 180
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'drivers_longitude_range_check'
    ) THEN
        ALTER TABLE "drivers" DROP CONSTRAINT "drivers_longitude_range_check";
    END IF;
END
$$;

ALTER TABLE "drivers" 
ADD CONSTRAINT "drivers_longitude_range_check" 
CHECK ("currentLongitude" IS NULL OR ("currentLongitude" >= -180 AND "currentLongitude" <= 180));

-- ==================== SAVED PLACES ====================
-- Constraint: Latitude must be between -90 and 90
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'saved_places_latitude_range_check'
    ) THEN
        ALTER TABLE "saved_places" DROP CONSTRAINT "saved_places_latitude_range_check";
    END IF;
END
$$;

ALTER TABLE "saved_places" 
ADD CONSTRAINT "saved_places_latitude_range_check" 
CHECK ("latitude" >= -90 AND "latitude" <= 90);

-- Constraint: Longitude must be between -180 and 180
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'saved_places_longitude_range_check'
    ) THEN
        ALTER TABLE "saved_places" DROP CONSTRAINT "saved_places_longitude_range_check";
    END IF;
END
$$;

ALTER TABLE "saved_places" 
ADD CONSTRAINT "saved_places_longitude_range_check" 
CHECK ("longitude" >= -180 AND "longitude" <= 180);
