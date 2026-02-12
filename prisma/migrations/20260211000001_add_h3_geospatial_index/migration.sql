-- Add H3 geospatial index field to drivers table
-- H3 is Uber's hexagonal hierarchical spatial index for efficient geospatial queries

-- Add h3Index column for storing hexagonal cell identifier
ALTER TABLE "drivers" ADD COLUMN "h3Index" TEXT;

-- Create index on h3Index for fast geospatial lookups
-- This is critical for performance - enables indexed queries instead of full table scans
CREATE INDEX "drivers_h3Index_idx" ON "drivers"("h3Index");

-- Create composite index for common query pattern: online drivers in H3 cell
CREATE INDEX "drivers_h3Index_isOnline_isActive_idx" ON "drivers"("h3Index", "isOnline", "isActive");

-- Note: Run the following SQL to backfill H3 indices for existing drivers
-- This should be done as a separate data migration after deploying the schema change:
--
-- UPDATE drivers 
-- SET h3Index = h3_lat_lng_to_cell(currentLatitude, currentLongitude, 9)
-- WHERE currentLatitude IS NOT NULL AND currentLongitude IS NOT NULL;
--
-- (Requires PostGIS H3 extension or application-level backfill)
