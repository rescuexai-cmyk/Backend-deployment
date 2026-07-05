-- Seed script for platform_config table
-- Sets platform fee rate to 2% (competitive with market)
-- Execute: psql $DATABASE_URL -f prisma/seed_platform_config.sql

INSERT INTO platform_config (id, key, value, description, "updatedAt")
VALUES
  (gen_random_uuid()::text, 'platform_fee_rate', '0.02', 'Platform commission rate (2%)', NOW()),
  (gen_random_uuid()::text, 'special_event_active', 'false', 'Enable special event surge pricing', NOW()),
  (gen_random_uuid()::text, 'max_surge_multiplier', '2.0', 'Maximum surge multiplier cap', NOW()),
  (gen_random_uuid()::text, 'free_waiting_minutes', '3', 'Free waiting time at pickup (minutes)', NOW()),
  (gen_random_uuid()::text, 'waiting_rate_per_min', '2', 'Waiting charge per minute after free period', NOW())
ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  "updatedAt" = NOW();

-- ─────────────────────────────────────────────────────────────
-- Service rollout config (drives GET /api/pricing/available-services)
-- JSON shape:
--   {
--     "default": { "<serviceId>": "live|coming_soon|disabled" },
--     "cities":  { "<city>": { "<serviceId>": "live|coming_soon|disabled" } }
--   }
-- Omitted services fall back to code defaults (cab_xl/cab_premium/personal_driver
-- are "coming_soon"; everything else is "live"). This seed reproduces the app's
-- previous hardcoded behaviour, so nothing changes until ops edit this row.
-- Example: to launch Cab Premium only in Noida, set cities.noida.cab_premium = "live".
-- ─────────────────────────────────────────────────────────────
INSERT INTO platform_config (id, key, value, description, "updatedAt")
VALUES
  (
    gen_random_uuid()::text,
    'service_rollout_v1',
    '{"default":{"cab_mini":"live","auto":"live","bike_taxi":"live","bike_rescue":"live","cab_xl":"live","cab_premium":"live","personal_driver":"live"},"cities":{}}',
    'Per-city service availability (live/coming_soon/disabled) for the rider app catalog',
    NOW()
  )
-- DO NOTHING: never overwrite an ops-edited rollout on re-seed.
ON CONFLICT (key) DO NOTHING;
