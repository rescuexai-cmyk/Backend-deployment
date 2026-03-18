-- Pricing policy v2 schema additions
-- Non-breaking: new tables only

CREATE TABLE IF NOT EXISTS "pricing_city_policy" (
    "id" TEXT NOT NULL,
    "cityCode" TEXT NOT NULL,
    "marketplaceMode" TEXT NOT NULL DEFAULT 'scale',
    "launchSubsidyPct" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "launchSubsidyCap" DOUBLE PRECISION NOT NULL DEFAULT 80,
    "burnCap" DOUBLE PRECISION NOT NULL DEFAULT 0.22,
    "contributionFloor" DOUBLE PRECISION NOT NULL DEFAULT -40,
    "etaTargetMin" DOUBLE PRECISION NOT NULL DEFAULT 8,
    "supplyThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.9,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_city_policy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pricing_city_policy_cityCode_key" ON "pricing_city_policy"("cityCode");
CREATE INDEX IF NOT EXISTS "pricing_city_policy_isActive_idx" ON "pricing_city_policy"("isActive");
CREATE INDEX IF NOT EXISTS "pricing_city_policy_marketplaceMode_idx" ON "pricing_city_policy"("marketplaceMode");

CREATE TABLE IF NOT EXISTS "pricing_burn_metrics" (
    "id" TEXT NOT NULL,
    "cityCode" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "gmv" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subsidy" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "incentives" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "burnRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_burn_metrics_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pricing_burn_metrics_cityCode_date_key" ON "pricing_burn_metrics"("cityCode", "date");
CREATE INDEX IF NOT EXISTS "pricing_burn_metrics_cityCode_date_idx" ON "pricing_burn_metrics"("cityCode", "date");

CREATE TABLE IF NOT EXISTS "pricing_zone_health" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "cityCode" TEXT NOT NULL,
    "fulfillment" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "etaP90" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "acceptRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "healthScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pricing_zone_health_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "pricing_zone_health_zoneId_cityCode_key" ON "pricing_zone_health"("zoneId", "cityCode");
CREATE INDEX IF NOT EXISTS "pricing_zone_health_cityCode_healthScore_idx" ON "pricing_zone_health"("cityCode", "healthScore");
CREATE INDEX IF NOT EXISTS "pricing_zone_health_observedAt_idx" ON "pricing_zone_health"("observedAt");
