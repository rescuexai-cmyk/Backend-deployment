-- Server-driven promo/coupon codes. Editable at runtime (admin API) so
-- discounts can change daily without shipping a new app build.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PromoType') THEN
    CREATE TYPE "PromoType" AS ENUM ('PERCENT', 'FLAT', 'CASHBACK');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "promos" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "PromoType" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "maxDiscount" DOUBLE PRECISION,
    "minFare" DOUBLE PRECISION,
    "usageLimit" INTEGER,
    "perUserLimit" INTEGER NOT NULL DEFAULT 1,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validTo" TIMESTAMP(3),
    "vehicleTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isFirstRideOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "promos_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "promos_code_key" ON "promos"("code");
CREATE INDEX IF NOT EXISTS "promos_code_idx" ON "promos"("code");
CREATE INDEX IF NOT EXISTS "promos_isActive_idx" ON "promos"("isActive");
CREATE INDEX IF NOT EXISTS "promos_validFrom_validTo_idx" ON "promos"("validFrom", "validTo");

CREATE TABLE IF NOT EXISTS "promo_usages" (
    "id" TEXT NOT NULL,
    "promoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rideId" TEXT,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "promo_usages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "promo_usages_promoId_userId_rideId_key" ON "promo_usages"("promoId", "userId", "rideId");
CREATE INDEX IF NOT EXISTS "promo_usages_promoId_idx" ON "promo_usages"("promoId");
CREATE INDEX IF NOT EXISTS "promo_usages_userId_idx" ON "promo_usages"("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'promo_usages_promoId_fkey'
  ) THEN
    ALTER TABLE "promo_usages"
      ADD CONSTRAINT "promo_usages_promoId_fkey"
      FOREIGN KEY ("promoId") REFERENCES "promos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
