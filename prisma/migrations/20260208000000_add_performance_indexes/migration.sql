-- Migration: Add Performance Indexes and Constraints
-- This migration adds database indexes to improve query performance at scale
-- and adds field length constraints for data integrity

-- ==================== SAVED PLACES ====================
CREATE INDEX IF NOT EXISTS "saved_places_userId_idx" ON "saved_places"("userId");

-- ==================== SUPPORT TICKETS ====================
-- Note: Also adding field length constraints via ALTER TABLE
CREATE INDEX IF NOT EXISTS "support_tickets_userId_idx" ON "support_tickets"("userId");
CREATE INDEX IF NOT EXISTS "support_tickets_driverId_idx" ON "support_tickets"("driverId");
CREATE INDEX IF NOT EXISTS "support_tickets_status_idx" ON "support_tickets"("status");
CREATE INDEX IF NOT EXISTS "support_tickets_createdAt_idx" ON "support_tickets"("createdAt");

-- ==================== DRIVERS ====================
CREATE INDEX IF NOT EXISTS "drivers_isOnline_isActive_idx" ON "drivers"("isOnline", "isActive");
CREATE INDEX IF NOT EXISTS "drivers_currentLatitude_currentLongitude_idx" ON "drivers"("currentLatitude", "currentLongitude");
CREATE INDEX IF NOT EXISTS "drivers_onboardingStatus_idx" ON "drivers"("onboardingStatus");

-- ==================== DRIVER PENALTIES ====================
CREATE INDEX IF NOT EXISTS "driver_penalties_driverId_idx" ON "driver_penalties"("driverId");
CREATE INDEX IF NOT EXISTS "driver_penalties_status_idx" ON "driver_penalties"("status");

-- ==================== DRIVER DOCUMENTS ====================
CREATE INDEX IF NOT EXISTS "driver_documents_driverId_idx" ON "driver_documents"("driverId");
CREATE INDEX IF NOT EXISTS "driver_documents_documentType_idx" ON "driver_documents"("documentType");

-- ==================== DRIVER EARNINGS ====================
CREATE INDEX IF NOT EXISTS "driver_earnings_driverId_idx" ON "driver_earnings"("driverId");
CREATE INDEX IF NOT EXISTS "driver_earnings_date_idx" ON "driver_earnings"("date");
CREATE INDEX IF NOT EXISTS "driver_earnings_driverId_date_idx" ON "driver_earnings"("driverId", "date");

-- ==================== RIDES ====================
CREATE INDEX IF NOT EXISTS "rides_passengerId_idx" ON "rides"("passengerId");
CREATE INDEX IF NOT EXISTS "rides_driverId_idx" ON "rides"("driverId");
CREATE INDEX IF NOT EXISTS "rides_status_idx" ON "rides"("status");
CREATE INDEX IF NOT EXISTS "rides_createdAt_idx" ON "rides"("createdAt");
CREATE INDEX IF NOT EXISTS "rides_status_driverId_idx" ON "rides"("status", "driverId");
CREATE INDEX IF NOT EXISTS "rides_passengerId_status_idx" ON "rides"("passengerId", "status");

-- ==================== RIDE SHARE TOKENS ====================
CREATE INDEX IF NOT EXISTS "ride_share_tokens_rideId_idx" ON "ride_share_tokens"("rideId");
CREATE INDEX IF NOT EXISTS "ride_share_tokens_expiresAt_idx" ON "ride_share_tokens"("expiresAt");

-- ==================== RIDE TRACKING ====================
CREATE INDEX IF NOT EXISTS "ride_tracking_rideId_idx" ON "ride_tracking"("rideId");
CREATE INDEX IF NOT EXISTS "ride_tracking_timestamp_idx" ON "ride_tracking"("timestamp");

-- ==================== RIDE MESSAGES ====================
CREATE INDEX IF NOT EXISTS "ride_messages_rideId_idx" ON "ride_messages"("rideId");
CREATE INDEX IF NOT EXISTS "ride_messages_timestamp_idx" ON "ride_messages"("timestamp");

-- ==================== REFRESH TOKENS ====================
CREATE INDEX IF NOT EXISTS "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- ==================== NOTIFICATIONS ====================
CREATE INDEX IF NOT EXISTS "notifications_userId_idx" ON "notifications"("userId");
CREATE INDEX IF NOT EXISTS "notifications_userId_isRead_idx" ON "notifications"("userId", "isRead");
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx" ON "notifications"("createdAt");

-- ==================== PRICING RULES ====================
CREATE INDEX IF NOT EXISTS "pricing_rules_isActive_idx" ON "pricing_rules"("isActive");
CREATE INDEX IF NOT EXISTS "pricing_rules_validFrom_validTo_idx" ON "pricing_rules"("validFrom", "validTo");

-- ==================== SURGE AREAS ====================
CREATE INDEX IF NOT EXISTS "surge_areas_isActive_idx" ON "surge_areas"("isActive");
CREATE INDEX IF NOT EXISTS "surge_areas_centerLatitude_centerLongitude_idx" ON "surge_areas"("centerLatitude", "centerLongitude");

-- ==================== FIELD LENGTH CONSTRAINTS ====================
-- Note: These ALTER TABLE statements modify column types for better data integrity
-- Run these only if the columns don't already have the constraints

-- Support Tickets
ALTER TABLE "support_tickets" ALTER COLUMN "description" TYPE VARCHAR(2000);
ALTER TABLE "support_tickets" ALTER COLUMN "response" TYPE VARCHAR(2000);

-- Rides
ALTER TABLE "rides" ALTER COLUMN "passengerFeedback" TYPE VARCHAR(500);
ALTER TABLE "rides" ALTER COLUMN "driverFeedback" TYPE VARCHAR(500);

-- Ride Messages
ALTER TABLE "ride_messages" ALTER COLUMN "message" TYPE VARCHAR(1000);
