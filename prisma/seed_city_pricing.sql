-- Seed script for city_pricing table
-- Per-city/region pricing for Delhi NCR, Haryana, UP
-- Execute: psql $DATABASE_URL -f prisma/seed_city_pricing.sql

-- Delhi NCR pricing
INSERT INTO city_pricing (id, city, "vehicleType", "startingFee", "ratePerKm", "ratePerMin", "minimumFare", "isActive", "createdAt", "updatedAt")
VALUES
  -- Delhi
  (gen_random_uuid()::text, 'delhi', 'cab_mini', 30, 12, 1.5, 35, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'delhi', 'auto', 25, 8, 1.5, 29, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'delhi', 'cab_xl', 30, 18, 2, 49, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'delhi', 'bike_rescue', 20, 6, 1, 19, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'delhi', 'cab_premium', 50, 25, 3, 99, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'delhi', 'personal_driver', 149, 0, 3.5, 149, true, NOW(), NOW()),
  
  -- Gurgaon (Haryana)
  (gen_random_uuid()::text, 'gurgaon', 'cab_mini', 30, 12, 1.5, 35, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'gurgaon', 'auto', 25, 8, 1.5, 29, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'gurgaon', 'cab_xl', 30, 18, 2, 49, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'gurgaon', 'bike_rescue', 20, 6, 1, 19, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'gurgaon', 'cab_premium', 50, 25, 3, 99, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'gurgaon', 'personal_driver', 149, 0, 3.5, 149, true, NOW(), NOW()),
  
  -- Noida (UP)
  (gen_random_uuid()::text, 'noida', 'cab_mini', 30, 12, 1.5, 35, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'noida', 'auto', 25, 8, 1.5, 29, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'noida', 'cab_xl', 30, 18, 2, 49, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'noida', 'bike_rescue', 20, 6, 1, 19, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'noida', 'cab_premium', 50, 25, 3, 99, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'noida', 'personal_driver', 149, 0, 3.5, 149, true, NOW(), NOW()),
  
  -- Faridabad (Haryana)
  (gen_random_uuid()::text, 'faridabad', 'cab_mini', 30, 12, 1.5, 35, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'faridabad', 'auto', 25, 8, 1.5, 29, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'faridabad', 'cab_xl', 30, 18, 2, 49, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'faridabad', 'bike_rescue', 20, 6, 1, 19, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'faridabad', 'cab_premium', 50, 25, 3, 99, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'faridabad', 'personal_driver', 149, 0, 3.5, 149, true, NOW(), NOW()),
  
  -- Ghaziabad (UP)
  (gen_random_uuid()::text, 'ghaziabad', 'cab_mini', 30, 12, 1.5, 35, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'ghaziabad', 'auto', 25, 8, 1.5, 29, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'ghaziabad', 'cab_xl', 30, 18, 2, 49, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'ghaziabad', 'bike_rescue', 20, 6, 1, 19, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'ghaziabad', 'cab_premium', 50, 25, 3, 99, true, NOW(), NOW()),
  (gen_random_uuid()::text, 'ghaziabad', 'personal_driver', 149, 0, 3.5, 149, true, NOW(), NOW())
ON CONFLICT (city, "vehicleType") DO UPDATE SET
  "startingFee" = EXCLUDED."startingFee",
  "ratePerKm" = EXCLUDED."ratePerKm",
  "ratePerMin" = EXCLUDED."ratePerMin",
  "minimumFare" = EXCLUDED."minimumFare",
  "updatedAt" = NOW();

-- Cancellation policies per vehicle type
-- Rules: Free within 2 min of assignment, free waiting 3 min after arrival, then per-minute fee
INSERT INTO cancellation_policies (id, "vehicleType", city, "freeWindowMinutes", "freeWaitingMinutes", "waitingFeePerMin", "isActive", "createdAt")
VALUES
  (gen_random_uuid()::text, 'cab_mini', NULL, 2, 3, 2.0, true, NOW()),
  (gen_random_uuid()::text, 'auto', NULL, 2, 3, 1.5, true, NOW()),
  (gen_random_uuid()::text, 'cab_xl', NULL, 2, 3, 2.5, true, NOW()),
  (gen_random_uuid()::text, 'bike_rescue', NULL, 2, 3, 1.0, true, NOW()),
  (gen_random_uuid()::text, 'cab_premium', NULL, 2, 3, 3.5, true, NOW()),
  (gen_random_uuid()::text, 'personal_driver', NULL, 2, 3, 3.5, true, NOW())
ON CONFLICT ("vehicleType", city) DO UPDATE SET
  "freeWindowMinutes" = EXCLUDED."freeWindowMinutes",
  "freeWaitingMinutes" = EXCLUDED."freeWaitingMinutes",
  "waitingFeePerMin" = EXCLUDED."waitingFeePerMin";
