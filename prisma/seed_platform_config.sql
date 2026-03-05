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
