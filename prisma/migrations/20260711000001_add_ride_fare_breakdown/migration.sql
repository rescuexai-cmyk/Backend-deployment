-- Persist pricing-service fare snapshot on each ride for receipt display.
ALTER TABLE "rides" ADD COLUMN IF NOT EXISTS "fareBreakdown" JSONB;
