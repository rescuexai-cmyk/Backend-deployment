-- Marketing banners for in-app carousels (editable via admin dashboard).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'BannerPlacement') THEN
    CREATE TYPE "BannerPlacement" AS ENUM ('HOME', 'RIDES', 'PROFILE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "banners" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "linkUrl" TEXT,
    "placement" "BannerPlacement" NOT NULL DEFAULT 'HOME',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validTo" TIMESTAMP(3),
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "banners_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "banners_placement_isActive_idx" ON "banners"("placement", "isActive");
CREATE INDEX IF NOT EXISTS "banners_sortOrder_idx" ON "banners"("sortOrder");
CREATE INDEX IF NOT EXISTS "banners_validFrom_validTo_idx" ON "banners"("validFrom", "validTo");
