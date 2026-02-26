-- ============================================================
-- RAAHI BACKEND - COMPLETE DATABASE SCHEMA
-- Generated from Prisma Schema
-- Last Updated: 2026-02-25
-- ============================================================
-- This schema supports all microservices:
--   - Auth Service
--   - User Service  
--   - Driver Service
--   - Ride Service
--   - Pricing Service
--   - Notification Service
--   - Admin Service
-- ============================================================

-- ============================================================
-- ENUMS
-- ============================================================

CREATE TYPE "DocumentType" AS ENUM (
  'LICENSE',
  'RC',
  'INSURANCE',
  'PUC',
  'PROFILE_PHOTO',
  'PAN_CARD',
  'AADHAAR_CARD'
);

CREATE TYPE "OnboardingStatus" AS ENUM (
  'EMAIL_COLLECTION',
  'LANGUAGE_SELECTION',
  'EARNING_SETUP',
  'VEHICLE_SELECTION',
  'LICENSE_UPLOAD',
  'PROFILE_PHOTO',
  'PHOTO_CONFIRMATION',
  'DOCUMENT_UPLOAD',
  'DOCUMENT_VERIFICATION',
  'COMPLETED',
  'REJECTED'
);

CREATE TYPE "RideStatus" AS ENUM (
  'PENDING',
  'CONFIRMED',
  'DRIVER_ASSIGNED',
  'DRIVER_ARRIVED',
  'RIDE_STARTED',
  'RIDE_COMPLETED',
  'CANCELLED'
);

CREATE TYPE "PaymentMethod" AS ENUM (
  'CASH',
  'CARD',
  'UPI',
  'WALLET'
);

CREATE TYPE "PaymentStatus" AS ENUM (
  'PENDING',
  'PAID',
  'FAILED',
  'REFUNDED'
);

CREATE TYPE "PenaltyStatus" AS ENUM (
  'PENDING',
  'PAID'
);

CREATE TYPE "NotificationType" AS ENUM (
  'RIDE_UPDATE',
  'PAYMENT',
  'PROMOTION',
  'SYSTEM',
  'SUPPORT'
);

CREATE TYPE "SupportPriority" AS ENUM (
  'LOW',
  'MEDIUM',
  'HIGH'
);

CREATE TYPE "SupportTicketStatus" AS ENUM (
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED'
);

-- ============================================================
-- USERS TABLE (Auth & User Service)
-- Both riders and drivers share the same identity table
-- ============================================================
CREATE TABLE IF NOT EXISTS "users" (
  "id"                  TEXT PRIMARY KEY,
  "email"               VARCHAR(255) UNIQUE,
  "phone"               VARCHAR(20) UNIQUE NOT NULL,
  "firstName"           VARCHAR(100) NOT NULL,
  "lastName"            VARCHAR(100),
  "profileImage"        TEXT,
  "isVerified"          BOOLEAN NOT NULL DEFAULT false,
  "isActive"            BOOLEAN NOT NULL DEFAULT true,
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lastLoginAt"         TIMESTAMPTZ,
  
  -- Firebase Auth integration
  "firebaseUid"         VARCHAR(255) UNIQUE,
  
  -- Push notification tokens (FCM)
  "fcmToken"            TEXT,
  "fcmTokenUpdatedAt"   TIMESTAMPTZ,
  "devicePlatform"      VARCHAR(20),  -- 'ios', 'android', 'web'
  "deviceId"            VARCHAR(255),
  
  -- Last known location
  "lastLatitude"        DOUBLE PRECISION,
  "lastLongitude"       DOUBLE PRECISION,
  "lastLocationAt"      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "idx_users_phone" ON "users"("phone");
CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users"("email");
CREATE INDEX IF NOT EXISTS "idx_users_firebase_uid" ON "users"("firebaseUid");
CREATE INDEX IF NOT EXISTS "idx_users_fcm_token" ON "users"("fcmToken");
CREATE INDEX IF NOT EXISTS "idx_users_location" ON "users"("lastLatitude", "lastLongitude");

-- ============================================================
-- SAVED PLACES (User Service)
-- User's saved locations (Home, Work, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS "saved_places" (
  "id"          TEXT PRIMARY KEY,
  "userId"      TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name"        VARCHAR(100) NOT NULL,  -- e.g. "Home", "Work", "Gym"
  "address"     TEXT NOT NULL,
  "latitude"    DOUBLE PRECISION NOT NULL,
  "longitude"   DOUBLE PRECISION NOT NULL,
  "placeType"   VARCHAR(20),  -- home, work, other
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_saved_places_user_id" ON "saved_places"("userId");

-- ============================================================
-- DRIVERS TABLE (Driver Service)
-- Driver-specific data extending users
-- ============================================================
CREATE TABLE IF NOT EXISTS "drivers" (
  "id"                    TEXT PRIMARY KEY,
  "userId"                TEXT UNIQUE NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "licenseNumber"         VARCHAR(50) UNIQUE,
  "licenseExpiry"         TIMESTAMPTZ,
  "vehicleNumber"         VARCHAR(20) UNIQUE,
  "vehicleModel"          VARCHAR(100),
  "vehicleColor"          VARCHAR(50),
  "vehicleYear"           INT,
  "isVerified"            BOOLEAN NOT NULL DEFAULT false,
  "isActive"              BOOLEAN NOT NULL DEFAULT true,
  "isOnline"              BOOLEAN NOT NULL DEFAULT false,
  "currentLatitude"       DOUBLE PRECISION,
  "currentLongitude"      DOUBLE PRECISION,
  "h3Index"               VARCHAR(20),  -- H3 hexagonal geospatial index
  "rating"                DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "ratingCount"           INT NOT NULL DEFAULT 0,
  "totalRides"            INT NOT NULL DEFAULT 0,
  "totalEarnings"         DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "totalOnlineSeconds"    INT NOT NULL DEFAULT 0,
  "joinedAt"              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "lastActiveAt"          TIMESTAMPTZ,
  "lastOnlineAt"          TIMESTAMPTZ,
  
  -- Onboarding fields
  "onboardingStatus"      "OnboardingStatus" NOT NULL DEFAULT 'EMAIL_COLLECTION',
  "preferredLanguage"     VARCHAR(10),
  "vehicleType"           VARCHAR(30),
  "serviceTypes"          TEXT[],  -- Array: ["bike_rescue", "raahi_driver"]
  "documentsSubmittedAt"  TIMESTAMPTZ,
  "documentsVerifiedAt"   TIMESTAMPTZ,
  "verificationNotes"     TEXT,
  "referralCode"          VARCHAR(50),
  
  -- KYC/Verification fields
  "aadhaarNumber"         VARCHAR(20) UNIQUE,  -- 12-digit Aadhaar (encrypted)
  "aadhaarVerified"       BOOLEAN NOT NULL DEFAULT false,
  "aadhaarVerifiedAt"     TIMESTAMPTZ,
  "panNumber"             VARCHAR(15) UNIQUE,  -- 10-char PAN (e.g., ABCDE1234F)
  "panVerified"           BOOLEAN NOT NULL DEFAULT false,
  "panVerifiedAt"         TIMESTAMPTZ,
  "digilockerLinked"      BOOLEAN NOT NULL DEFAULT false,
  "digilockerToken"       TEXT,  -- DigiLocker access token (encrypted)
  
  -- Settings
  "notificationsEnabled"  BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS "idx_drivers_user_id" ON "drivers"("userId");
CREATE INDEX IF NOT EXISTS "idx_drivers_online_active" ON "drivers"("isOnline", "isActive");
CREATE INDEX IF NOT EXISTS "idx_drivers_location" ON "drivers"("currentLatitude", "currentLongitude");
CREATE INDEX IF NOT EXISTS "idx_drivers_h3_index" ON "drivers"("h3Index");
CREATE INDEX IF NOT EXISTS "idx_drivers_onboarding_status" ON "drivers"("onboardingStatus");

-- ============================================================
-- DRIVER DOCUMENTS (Driver Service)
-- Document uploads with AI Vision verification
-- ============================================================
CREATE TABLE IF NOT EXISTS "driver_documents" (
  "id"                  TEXT PRIMARY KEY,
  "driverId"            TEXT NOT NULL REFERENCES "drivers"("id") ON DELETE CASCADE,
  "documentType"        "DocumentType" NOT NULL,
  "documentUrl"         TEXT NOT NULL,
  "documentName"        VARCHAR(255),
  "documentSize"        INT,
  "isVerified"          BOOLEAN NOT NULL DEFAULT false,
  "verifiedAt"          TIMESTAMPTZ,
  "verifiedBy"          VARCHAR(100),  -- Admin ID or "AI_VISION" or "AUTO_APPROVED" or "MANUAL_ADMIN"
  "rejectionReason"     TEXT,
  "uploadedAt"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- AI Vision verification fields
  "aiVerified"          BOOLEAN NOT NULL DEFAULT false,
  "aiConfidence"        DOUBLE PRECISION,  -- 0.0 to 1.0
  "aiExtractedData"     JSONB,  -- Extracted text, name, numbers, etc.
  "aiVerifiedAt"        TIMESTAMPTZ,
  "aiMismatchReason"    TEXT,
  "verificationStatus"  VARCHAR(20) NOT NULL DEFAULT 'pending'  -- pending, processing, verified, flagged, failed
);

CREATE INDEX IF NOT EXISTS "idx_driver_documents_driver_id" ON "driver_documents"("driverId");
CREATE INDEX IF NOT EXISTS "idx_driver_documents_type" ON "driver_documents"("documentType");
CREATE INDEX IF NOT EXISTS "idx_driver_documents_status" ON "driver_documents"("verificationStatus");

-- ============================================================
-- DRIVER EARNINGS (Driver Service)
-- Per-ride earnings breakdown
-- ============================================================
CREATE TABLE IF NOT EXISTS "driver_earnings" (
  "id"              TEXT PRIMARY KEY,
  "driverId"        TEXT NOT NULL REFERENCES "drivers"("id") ON DELETE CASCADE,
  "rideId"          TEXT UNIQUE,
  "amount"          DOUBLE PRECISION NOT NULL,  -- Gross fare
  "commission"      DOUBLE PRECISION NOT NULL,  -- Platform fee deducted
  "commissionRate"  DOUBLE PRECISION NOT NULL DEFAULT 0.20,  -- 20%
  "netAmount"       DOUBLE PRECISION NOT NULL,  -- amount - commission
  "baseFare"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "distanceFare"    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "timeFare"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "surgeFare"       DOUBLE PRECISION NOT NULL DEFAULT 0,
  "date"            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_driver_earnings_driver_id" ON "driver_earnings"("driverId");
CREATE INDEX IF NOT EXISTS "idx_driver_earnings_date" ON "driver_earnings"("date");
CREATE INDEX IF NOT EXISTS "idx_driver_earnings_driver_date" ON "driver_earnings"("driverId", "date");

-- ============================================================
-- DRIVER PENALTIES (Driver Service)
-- Fines/penalties for policy violations
-- ============================================================
CREATE TABLE IF NOT EXISTS "driver_penalties" (
  "id"          TEXT PRIMARY KEY,
  "driverId"    TEXT NOT NULL REFERENCES "drivers"("id") ON DELETE CASCADE,
  "amount"      DOUBLE PRECISION NOT NULL,  -- in INR
  "reason"      VARCHAR(100) NOT NULL,  -- e.g. "STOP_RIDING", "NO_SHOW"
  "status"      "PenaltyStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "paidAt"      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "idx_driver_penalties_driver_id" ON "driver_penalties"("driverId");
CREATE INDEX IF NOT EXISTS "idx_driver_penalties_status" ON "driver_penalties"("status");

-- ============================================================
-- RIDES TABLE (Ride Service)
-- Core ride booking and tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS "rides" (
  "id"                  TEXT PRIMARY KEY,
  "passengerId"         TEXT NOT NULL REFERENCES "users"("id"),
  "driverId"            TEXT REFERENCES "drivers"("id"),
  "pickupLatitude"      DOUBLE PRECISION NOT NULL,
  "pickupLongitude"     DOUBLE PRECISION NOT NULL,
  "dropLatitude"        DOUBLE PRECISION NOT NULL,
  "dropLongitude"       DOUBLE PRECISION NOT NULL,
  "pickupAddress"       TEXT NOT NULL,
  "dropAddress"         TEXT NOT NULL,
  "distance"            DOUBLE PRECISION NOT NULL,  -- in kilometers
  "duration"            INT NOT NULL,  -- in minutes
  "baseFare"            DOUBLE PRECISION NOT NULL,
  "distanceFare"        DOUBLE PRECISION NOT NULL,
  "timeFare"            DOUBLE PRECISION NOT NULL,
  "surgeMultiplier"     DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "surgeFare"           DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "totalFare"           DOUBLE PRECISION NOT NULL,
  "status"              "RideStatus" NOT NULL DEFAULT 'PENDING',
  "paymentMethod"       "PaymentMethod" NOT NULL,
  "paymentStatus"       "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "rideOtp"             VARCHAR(6),  -- 4-digit OTP for ride verification
  "scheduledAt"         TIMESTAMPTZ,
  "startedAt"           TIMESTAMPTZ,
  "completedAt"         TIMESTAMPTZ,
  "cancelledAt"         TIMESTAMPTZ,
  "cancelledBy"         VARCHAR(20),  -- 'passenger' or 'driver'
  "cancellationReason"  TEXT,
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Rating fields
  "passengerRating"     INT CHECK ("passengerRating" >= 1 AND "passengerRating" <= 5),
  "passengerFeedback"   VARCHAR(500),
  "ratedByPassengerAt"  TIMESTAMPTZ,
  "driverRating"        INT CHECK ("driverRating" >= 1 AND "driverRating" <= 5),
  "driverFeedback"      VARCHAR(500),
  "ratedByDriverAt"     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "idx_rides_passenger_id" ON "rides"("passengerId");
CREATE INDEX IF NOT EXISTS "idx_rides_driver_id" ON "rides"("driverId");
CREATE INDEX IF NOT EXISTS "idx_rides_status" ON "rides"("status");
CREATE INDEX IF NOT EXISTS "idx_rides_created_at" ON "rides"("createdAt");
CREATE INDEX IF NOT EXISTS "idx_rides_status_driver" ON "rides"("status", "driverId");
CREATE INDEX IF NOT EXISTS "idx_rides_passenger_status" ON "rides"("passengerId", "status");

-- ============================================================
-- RIDE TRACKING (Ride Service)
-- Real-time location tracking during ride
-- ============================================================
CREATE TABLE IF NOT EXISTS "ride_tracking" (
  "id"          TEXT PRIMARY KEY,
  "rideId"      TEXT NOT NULL REFERENCES "rides"("id") ON DELETE CASCADE,
  "latitude"    DOUBLE PRECISION NOT NULL,
  "longitude"   DOUBLE PRECISION NOT NULL,
  "heading"     DOUBLE PRECISION,
  "speed"       DOUBLE PRECISION,
  "timestamp"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_ride_tracking_ride_id" ON "ride_tracking"("rideId");
CREATE INDEX IF NOT EXISTS "idx_ride_tracking_timestamp" ON "ride_tracking"("timestamp");

-- ============================================================
-- RIDE MESSAGES (Ride Service)
-- In-ride chat between passenger and driver
-- ============================================================
CREATE TABLE IF NOT EXISTS "ride_messages" (
  "id"          TEXT PRIMARY KEY,
  "rideId"      TEXT NOT NULL REFERENCES "rides"("id") ON DELETE CASCADE,
  "senderId"    TEXT NOT NULL,
  "message"     VARCHAR(1000) NOT NULL,
  "timestamp"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_ride_messages_ride_id" ON "ride_messages"("rideId");
CREATE INDEX IF NOT EXISTS "idx_ride_messages_timestamp" ON "ride_messages"("timestamp");

-- ============================================================
-- RIDE SHARE TOKENS (Ride Service)
-- Shareable links for live ride tracking
-- ============================================================
CREATE TABLE IF NOT EXISTS "ride_share_tokens" (
  "id"          TEXT PRIMARY KEY,
  "rideId"      TEXT NOT NULL REFERENCES "rides"("id") ON DELETE CASCADE,
  "token"       VARCHAR(100) UNIQUE NOT NULL,
  "expiresAt"   TIMESTAMPTZ NOT NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_ride_share_tokens_ride_id" ON "ride_share_tokens"("rideId");
CREATE INDEX IF NOT EXISTS "idx_ride_share_tokens_expires" ON "ride_share_tokens"("expiresAt");

-- ============================================================
-- REFRESH TOKENS (Auth Service)
-- JWT refresh token storage
-- ============================================================
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id"          TEXT PRIMARY KEY,
  "userId"      TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token"       TEXT UNIQUE NOT NULL,
  "expiresAt"   TIMESTAMPTZ NOT NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user_id" ON "refresh_tokens"("userId");
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_expires" ON "refresh_tokens"("expiresAt");

-- ============================================================
-- NOTIFICATIONS (Notification Service)
-- Push notifications and in-app notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS "notifications" (
  "id"              TEXT PRIMARY KEY,
  "userId"          TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "title"           VARCHAR(255) NOT NULL,
  "message"         TEXT NOT NULL,
  "type"            "NotificationType" NOT NULL,
  "isRead"          BOOLEAN NOT NULL DEFAULT false,
  "data"            JSONB,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Geo-targeting fields (for location-based notifications)
  "targetLatitude"  DOUBLE PRECISION,
  "targetLongitude" DOUBLE PRECISION,
  "targetRadius"    DOUBLE PRECISION  -- in kilometers
);

CREATE INDEX IF NOT EXISTS "idx_notifications_user_id" ON "notifications"("userId");
CREATE INDEX IF NOT EXISTS "idx_notifications_user_read" ON "notifications"("userId", "isRead");
CREATE INDEX IF NOT EXISTS "idx_notifications_created_at" ON "notifications"("createdAt");
CREATE INDEX IF NOT EXISTS "idx_notifications_geo" ON "notifications"("targetLatitude", "targetLongitude");

-- ============================================================
-- SUPPORT TICKETS (Admin Service)
-- Customer support tickets
-- ============================================================
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id"          TEXT PRIMARY KEY,
  "userId"      TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "driverId"    TEXT REFERENCES "drivers"("id") ON DELETE SET NULL,
  "issueType"   VARCHAR(100) NOT NULL,
  "description" VARCHAR(2000) NOT NULL,
  "priority"    "SupportPriority" NOT NULL DEFAULT 'MEDIUM',
  "status"      "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
  "response"    VARCHAR(2000),
  "respondedAt" TIMESTAMPTZ,
  "respondedBy" TEXT,  -- Admin user ID
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_support_tickets_user_id" ON "support_tickets"("userId");
CREATE INDEX IF NOT EXISTS "idx_support_tickets_driver_id" ON "support_tickets"("driverId");
CREATE INDEX IF NOT EXISTS "idx_support_tickets_status" ON "support_tickets"("status");
CREATE INDEX IF NOT EXISTS "idx_support_tickets_created_at" ON "support_tickets"("createdAt");

-- ============================================================
-- PRICING RULES (Pricing Service)
-- Dynamic pricing configuration
-- ============================================================
CREATE TABLE IF NOT EXISTS "pricing_rules" (
  "id"                  TEXT PRIMARY KEY,
  "name"                VARCHAR(100) NOT NULL,
  "baseFare"            DOUBLE PRECISION NOT NULL,
  "perKmRate"           DOUBLE PRECISION NOT NULL,
  "perMinuteRate"       DOUBLE PRECISION NOT NULL,
  "surgeMultiplier"     DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "peakHourMultiplier"  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  "isActive"            BOOLEAN NOT NULL DEFAULT true,
  "validFrom"           TIMESTAMPTZ NOT NULL,
  "validTo"             TIMESTAMPTZ,
  "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_pricing_rules_active" ON "pricing_rules"("isActive");
CREATE INDEX IF NOT EXISTS "idx_pricing_rules_validity" ON "pricing_rules"("validFrom", "validTo");

-- ============================================================
-- SURGE AREAS (Pricing Service)
-- Geographic surge pricing zones
-- ============================================================
CREATE TABLE IF NOT EXISTS "surge_areas" (
  "id"              TEXT PRIMARY KEY,
  "name"            VARCHAR(100) NOT NULL,
  "centerLatitude"  DOUBLE PRECISION NOT NULL,
  "centerLongitude" DOUBLE PRECISION NOT NULL,
  "radius"          DOUBLE PRECISION NOT NULL,  -- in kilometers
  "multiplier"      DOUBLE PRECISION NOT NULL,
  "isActive"        BOOLEAN NOT NULL DEFAULT true,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_surge_areas_active" ON "surge_areas"("isActive");
CREATE INDEX IF NOT EXISTS "idx_surge_areas_location" ON "surge_areas"("centerLatitude", "centerLongitude");

-- ============================================================
-- PLATFORM CONFIG (Admin Service)
-- Dynamic platform settings
-- ============================================================
CREATE TABLE IF NOT EXISTS "platform_config" (
  "id"          TEXT PRIMARY KEY,
  "key"         VARCHAR(100) UNIQUE NOT NULL,
  "value"       TEXT NOT NULL,  -- JSON or string value
  "description" TEXT,
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SUMMARY
-- ============================================================
-- Total Tables: 17
-- 
-- Auth Service:       users, refresh_tokens
-- User Service:       users, saved_places
-- Driver Service:     drivers, driver_documents, driver_earnings, driver_penalties
-- Ride Service:       rides, ride_tracking, ride_messages, ride_share_tokens
-- Pricing Service:    pricing_rules, surge_areas
-- Notification:       notifications
-- Admin Service:      support_tickets, platform_config
-- ============================================================
