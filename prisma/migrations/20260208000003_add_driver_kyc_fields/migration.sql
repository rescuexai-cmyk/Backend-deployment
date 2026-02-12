-- Add KYC/Verification fields to Driver model for driver onboarding
-- These fields support Aadhaar, PAN, and DigiLocker verification

-- Add referral code field
ALTER TABLE "drivers" ADD COLUMN "referralCode" TEXT;

-- Add Aadhaar verification fields
ALTER TABLE "drivers" ADD COLUMN "aadhaarNumber" TEXT;
ALTER TABLE "drivers" ADD COLUMN "aadhaarVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "drivers" ADD COLUMN "aadhaarVerifiedAt" TIMESTAMP(3);

-- Add unique constraint for Aadhaar (only one driver per Aadhaar)
CREATE UNIQUE INDEX "drivers_aadhaarNumber_key" ON "drivers"("aadhaarNumber");

-- Add PAN verification fields
ALTER TABLE "drivers" ADD COLUMN "panNumber" TEXT;
ALTER TABLE "drivers" ADD COLUMN "panVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "drivers" ADD COLUMN "panVerifiedAt" TIMESTAMP(3);

-- Add unique constraint for PAN (only one driver per PAN)
CREATE UNIQUE INDEX "drivers_panNumber_key" ON "drivers"("panNumber");

-- Add DigiLocker integration fields
ALTER TABLE "drivers" ADD COLUMN "digilockerLinked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "drivers" ADD COLUMN "digilockerToken" TEXT;
