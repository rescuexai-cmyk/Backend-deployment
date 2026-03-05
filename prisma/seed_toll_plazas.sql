-- Seed script for toll_plazas table (run after migration)
-- Major Indian toll plazas with NPCI/NHAI coordinates
-- Execute: psql $DATABASE_URL -f prisma/seed_toll_plazas.sql

INSERT INTO toll_plazas (id, name, latitude, longitude, amount, highway, city, state, "isActive", "createdAt")
VALUES
  (gen_random_uuid()::text, 'IGI Toll Plaza', 28.543853, 77.115435, 75, 'NH-48', 'New Delhi', 'Delhi', true, NOW()),
  (gen_random_uuid()::text, 'Kherki Daula', 28.395604, 76.981760, 80, 'NH-48', 'Gurgaon', 'Haryana', true, NOW()),
  (gen_random_uuid()::text, 'Gurugram-Farrukhnagar', 28.365000, 77.050000, 70, 'SH-10', 'Gurgaon', 'Haryana', true, NOW()),
  (gen_random_uuid()::text, 'Manesar Toll', 28.355000, 76.915000, 75, 'NH-48', 'Manesar', 'Haryana', true, NOW()),
  (gen_random_uuid()::text, 'DND Flyway', 28.582000, 77.332000, 55, 'DND', 'Noida', 'UP', true, NOW()),
  (gen_random_uuid()::text, 'Charoti Toll', 19.890544, 72.942644, 95, 'NH-48', 'Palghar', 'Maharashtra', true, NOW()),
  (gen_random_uuid()::text, 'Vashi Toll', 19.075000, 72.998000, 60, 'Sion-Panvel', 'Mumbai', 'Maharashtra', true, NOW()),
  (gen_random_uuid()::text, 'Boisar Toll', 19.780000, 72.780000, 75, 'NH-48', 'Boisar', 'Maharashtra', true, NOW()),
  (gen_random_uuid()::text, 'Mansar Toll', 21.382312, 79.253320, 90, 'NH-44', 'Nagpur', 'Maharashtra', true, NOW()),
  (gen_random_uuid()::text, 'Nagpur Bypass', 20.229935, 79.013193, 85, 'NH-44', 'Nagpur', 'Maharashtra', true, NOW()),
  (gen_random_uuid()::text, 'Karjeevanahally', 13.612918, 76.953866, 70, 'NH-48', 'Tumkur', 'Karnataka', true, NOW()),
  (gen_random_uuid()::text, 'Guilalu Toll', 14.053778, 76.560573, 75, 'NH-48', 'Chitradurga', 'Karnataka', true, NOW()),
  (gen_random_uuid()::text, 'Nelamangala', 13.090000, 77.380000, 65, 'NH-48', 'Bangalore Rural', 'Karnataka', true, NOW()),
  (gen_random_uuid()::text, 'Hosur Toll', 12.720000, 77.840000, 60, 'NH-44', 'Hosur', 'Tamil Nadu', true, NOW()),
  (gen_random_uuid()::text, 'Sriperumbudur', 12.968000, 79.948000, 55, 'NH-48', 'Chennai', 'Tamil Nadu', true, NOW()),
  (gen_random_uuid()::text, 'Shirwal Toll', 18.150000, 73.680000, 95, 'NH-48', 'Pune', 'Maharashtra', true, NOW()),
  (gen_random_uuid()::text, 'Talegaon Toll', 18.745000, 73.675000, 75, 'NH-48', 'Pune', 'Maharashtra', true, NOW()),
  (gen_random_uuid()::text, 'Shamirpet Toll', 17.445000, 78.568000, 70, 'NH-44', 'Hyderabad', 'Telangana', true, NOW()),
  (gen_random_uuid()::text, 'Neemrana Toll', 28.365000, 76.380000, 85, 'NH-48', 'Neemrana', 'Rajasthan', true, NOW()),
  (gen_random_uuid()::text, 'Angamaly Toll', 10.195000, 76.385000, 55, 'NH-544', 'Kochi', 'Kerala', true, NOW()),
  (gen_random_uuid()::text, 'Chorlem Toll', 15.355000, 73.985000, 75, 'NH-66', 'Goa', 'Goa', true, NOW())
;
