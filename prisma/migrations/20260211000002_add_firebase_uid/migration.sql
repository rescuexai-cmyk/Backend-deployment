-- Add Firebase UID field to users table
-- This stores the Firebase user ID for phone authentication

-- Add firebaseUid column
ALTER TABLE "users" ADD COLUMN "firebaseUid" TEXT;

-- Create unique index on firebaseUid
CREATE UNIQUE INDEX "users_firebaseUid_key" ON "users"("firebaseUid");

-- Create regular index for faster lookups
CREATE INDEX "users_firebaseUid_idx" ON "users"("firebaseUid");
