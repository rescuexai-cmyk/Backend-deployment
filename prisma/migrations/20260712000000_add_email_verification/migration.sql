-- Driver email verification (OTP via SMTP)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationOtp" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationOtpExpiresAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationSentAt" TIMESTAMP(3);
