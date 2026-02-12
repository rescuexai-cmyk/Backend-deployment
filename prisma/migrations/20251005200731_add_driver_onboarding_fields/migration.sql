-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('EMAIL_COLLECTION', 'LANGUAGE_SELECTION', 'EARNING_SETUP', 'VEHICLE_SELECTION', 'LICENSE_UPLOAD', 'PROFILE_PHOTO', 'PHOTO_CONFIRMATION', 'DOCUMENT_UPLOAD', 'DOCUMENT_VERIFICATION', 'COMPLETED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DocumentType" ADD VALUE 'PAN_CARD';
ALTER TYPE "DocumentType" ADD VALUE 'AADHAAR_CARD';

-- AlterTable
ALTER TABLE "driver_documents" ADD COLUMN     "documentName" TEXT,
ADD COLUMN     "documentSize" INTEGER,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "verifiedBy" TEXT;

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "documentsSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "documentsVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingStatus" "OnboardingStatus" NOT NULL DEFAULT 'EMAIL_COLLECTION',
ADD COLUMN     "preferredLanguage" TEXT,
ADD COLUMN     "serviceTypes" TEXT[],
ADD COLUMN     "vehicleType" TEXT,
ADD COLUMN     "verificationNotes" TEXT,
ALTER COLUMN "licenseNumber" DROP NOT NULL,
ALTER COLUMN "licenseExpiry" DROP NOT NULL,
ALTER COLUMN "vehicleNumber" DROP NOT NULL,
ALTER COLUMN "vehicleModel" DROP NOT NULL,
ALTER COLUMN "vehicleColor" DROP NOT NULL,
ALTER COLUMN "vehicleYear" DROP NOT NULL;
