-- Add FCM token fields to users table for push notifications
-- Migration: 20260211000003_add_fcm_token_fields

-- Step 1: Add FCM token fields to users table
ALTER TABLE "users" ADD COLUMN "fcmToken" TEXT;
ALTER TABLE "users" ADD COLUMN "fcmTokenUpdatedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "devicePlatform" TEXT;
ALTER TABLE "users" ADD COLUMN "deviceId" TEXT;

-- Step 2: Create index on fcmToken for efficient lookups
CREATE INDEX "users_fcmToken_idx" ON "users"("fcmToken");

-- Note: fcmToken is nullable because:
-- 1. Users who haven't registered their device yet won't have one
-- 2. Users who have logged out or disabled push notifications will have it cleared
-- 3. Web users may not support push notifications

-- devicePlatform values: 'ios', 'android', 'web'
-- deviceId: Optional unique device identifier for multi-device support in the future
