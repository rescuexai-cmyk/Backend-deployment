-- Operational zones (geofenced service areas) for permit rules & restrictions.
-- Geometry stored as H3 cell sets for deterministic point-in-zone lookups.

CREATE TABLE IF NOT EXISTS "zones" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'city',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "zones_code_key" ON "zones"("code");
CREATE INDEX IF NOT EXISTS "zones_isActive_idx" ON "zones"("isActive");

CREATE TABLE IF NOT EXISTS "zone_cells" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "h3Index" TEXT NOT NULL,
    CONSTRAINT "zone_cells_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "zone_cells_h3Index_key" ON "zone_cells"("h3Index");
CREATE INDEX IF NOT EXISTS "zone_cells_zoneId_idx" ON "zone_cells"("zoneId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'zone_cells_zoneId_fkey'
  ) THEN
    ALTER TABLE "zone_cells"
      ADD CONSTRAINT "zone_cells_zoneId_fkey"
      FOREIGN KEY ("zoneId") REFERENCES "zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
