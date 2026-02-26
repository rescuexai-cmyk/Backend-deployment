-- ============================================================
-- RAAHI PLATFORM - BULK DATA IMPORT SCRIPT
-- ============================================================
-- This script imports data from CSV files into PostgreSQL
-- Run this AFTER bulk_import_schema.sql
-- ============================================================

SET search_path TO ride_platform, public;

-- ============================================================
-- STEP 1: CREATE STAGING TABLES FOR CSV IMPORT
-- ============================================================

-- Staging table for authentication data
DROP TABLE IF EXISTS ride_platform.staging_auth;
CREATE TABLE ride_platform.staging_auth (
    auth_id TEXT,
    user_id TEXT,
    ride_id TEXT,
    login_method TEXT,
    authentication_status TEXT,
    last_login TIMESTAMPTZ
);

-- Staging table for driver data
DROP TABLE IF EXISTS ride_platform.staging_drivers;
CREATE TABLE ride_platform.staging_drivers (
    driver_id TEXT,
    ride_id TEXT,
    driver_name TEXT,
    driver_rating NUMERIC,
    vehicle_number TEXT,
    vehicle_type TEXT,
    driver_status TEXT
);

-- Staging table for pricing data
DROP TABLE IF EXISTS ride_platform.staging_pricing;
CREATE TABLE ride_platform.staging_pricing (
    pricing_id TEXT,
    ride_id TEXT,
    base_fare NUMERIC,
    distance_charge NUMERIC,
    time_charge NUMERIC,
    surge_multiplier NUMERIC,
    total_price NUMERIC
);

-- Staging table for payment data
DROP TABLE IF EXISTS ride_platform.staging_payments;
CREATE TABLE ride_platform.staging_payments (
    payment_id TEXT,
    ride_id TEXT,
    payment_method TEXT,
    payment_status TEXT,
    transaction_id TEXT,
    payment_timestamp TIMESTAMPTZ
);

-- Staging table for notification data
DROP TABLE IF EXISTS ride_platform.staging_notifications;
CREATE TABLE ride_platform.staging_notifications (
    notification_id TEXT,
    ride_id TEXT,
    user_id TEXT,
    notification_type TEXT,
    notification_channel TEXT,
    notification_status TEXT,
    sent_timestamp TIMESTAMPTZ
);

-- ============================================================
-- STEP 2: IMPORT CSV DATA INTO STAGING TABLES
-- ============================================================
-- NOTE: Update the file paths to match your environment
-- Run these COPY commands from psql or pgAdmin

-- Import authentication data
\COPY ride_platform.staging_auth FROM '/Users/anmolagarwal/Downloads/csv files of records/authentication_service_data.csv' WITH (FORMAT csv, HEADER true, DELIMITER ',');

-- Import driver data
\COPY ride_platform.staging_drivers FROM '/Users/anmolagarwal/Downloads/csv files of records/driver_service_data.csv' WITH (FORMAT csv, HEADER true, DELIMITER ',');

-- Import pricing data
\COPY ride_platform.staging_pricing FROM '/Users/anmolagarwal/Downloads/csv files of records/pricing_service_data.csv' WITH (FORMAT csv, HEADER true, DELIMITER ',');

-- Import payment data
\COPY ride_platform.staging_payments FROM '/Users/anmolagarwal/Downloads/csv files of records/payment_service_data.csv' WITH (FORMAT csv, HEADER true, DELIMITER ',');

-- Import notification data
\COPY ride_platform.staging_notifications FROM '/Users/anmolagarwal/Downloads/csv files of records/notification_service_data.csv' WITH (FORMAT csv, HEADER true, DELIMITER ',');

-- ============================================================
-- STEP 3: EXTRACT AND INSERT NORMALIZED DATA
-- ============================================================

-- 3.1 Insert unique users from authentication data
INSERT INTO ride_platform.users (id, name, email, phone, role, created_at)
SELECT DISTINCT 
    sa.user_id,
    'User_' || SUBSTRING(sa.user_id FROM 2) as name,
    LOWER(sa.user_id) || '@raahi.app' as email,
    '+91' || LPAD((RANDOM() * 9000000000 + 1000000000)::BIGINT::TEXT, 10, '0') as phone,
    'rider' as role,
    COALESCE(MIN(sa.last_login), NOW()) as created_at
FROM ride_platform.staging_auth sa
GROUP BY sa.user_id
ON CONFLICT (id) DO NOTHING;

-- 3.2 Insert unique drivers from driver data
INSERT INTO ride_platform.drivers (
    id, name, rating, vehicle_number, vehicle_type, status, created_at
)
SELECT DISTINCT ON (sd.driver_id)
    sd.driver_id,
    sd.driver_name,
    sd.driver_rating,
    sd.vehicle_number,
    sd.vehicle_type,
    CASE 
        WHEN sd.driver_status = 'Active' THEN 'active'
        WHEN sd.driver_status = 'Inactive' THEN 'inactive'
        WHEN sd.driver_status = 'Suspended' THEN 'suspended'
        ELSE 'inactive'
    END as status,
    NOW() as created_at
FROM ride_platform.staging_drivers sd
ON CONFLICT (id) DO NOTHING;

-- 3.3 Insert rides (combining data from all tables)
INSERT INTO ride_platform.rides (
    id, user_id, driver_id, 
    base_fare, distance_fare, time_fare, surge_multiplier, total_fare,
    payment_method, payment_status, status, created_at
)
SELECT DISTINCT ON (sp.ride_id)
    sp.ride_id as id,
    sa.user_id,
    sd.driver_id,
    spr.base_fare,
    spr.distance_charge as distance_fare,
    spr.time_charge as time_fare,
    spr.surge_multiplier,
    spr.total_price as total_fare,
    sp.payment_method,
    CASE 
        WHEN sp.payment_status = 'Completed' THEN 'paid'
        WHEN sp.payment_status = 'Failed' THEN 'failed'
        WHEN sp.payment_status = 'Pending' THEN 'pending'
        ELSE 'pending'
    END as payment_status,
    CASE 
        WHEN sp.payment_status = 'Completed' THEN 'completed'
        ELSE 'pending'
    END as status,
    COALESCE(sp.payment_timestamp, NOW()) as created_at
FROM ride_platform.staging_payments sp
LEFT JOIN ride_platform.staging_auth sa ON sp.ride_id = sa.ride_id
LEFT JOIN ride_platform.staging_drivers sd ON sp.ride_id = sd.ride_id
LEFT JOIN ride_platform.staging_pricing spr ON sp.ride_id = spr.ride_id
ON CONFLICT (id) DO NOTHING;

-- 3.4 Insert authentication records
INSERT INTO ride_platform.authentication (
    id, user_id, ride_id, login_method, authentication_status, last_login
)
SELECT 
    auth_id,
    user_id,
    ride_id,
    login_method,
    authentication_status,
    last_login
FROM ride_platform.staging_auth
ON CONFLICT (id) DO NOTHING;

-- 3.5 Insert pricing records
INSERT INTO ride_platform.pricing (
    id, ride_id, base_fare, distance_charge, time_charge, surge_multiplier, total_price
)
SELECT 
    pricing_id,
    ride_id,
    base_fare,
    distance_charge,
    time_charge,
    surge_multiplier,
    total_price
FROM ride_platform.staging_pricing
ON CONFLICT (id) DO NOTHING;

-- 3.6 Insert payment records
INSERT INTO ride_platform.payments (
    id, ride_id, amount, payment_method, payment_status, transaction_id, payment_timestamp
)
SELECT 
    payment_id,
    ride_id,
    (SELECT total_price FROM ride_platform.staging_pricing WHERE ride_id = sp.ride_id LIMIT 1) as amount,
    payment_method,
    payment_status,
    transaction_id,
    payment_timestamp
FROM ride_platform.staging_payments sp
ON CONFLICT (id) DO NOTHING;

-- 3.7 Insert revenue records (calculate from pricing/payments)
INSERT INTO ride_platform.revenue (
    id, ride_id, payment_id, gross_amount, commission_amount, commission_rate,
    driver_payout, platform_fee, net_revenue
)
SELECT 
    'REV' || SUBSTRING(sp.payment_id FROM 4) as id,
    sp.ride_id,
    sp.payment_id,
    spr.total_price as gross_amount,
    ROUND(spr.total_price * 0.20, 2) as commission_amount,
    0.20 as commission_rate,
    ROUND(spr.total_price * 0.80, 2) as driver_payout,
    ROUND(spr.total_price * 0.02, 2) as platform_fee,
    ROUND(spr.total_price * 0.22, 2) as net_revenue
FROM ride_platform.staging_payments sp
JOIN ride_platform.staging_pricing spr ON sp.ride_id = spr.ride_id
WHERE sp.payment_status = 'Completed'
ON CONFLICT (id) DO NOTHING;

-- 3.8 Insert notification records
INSERT INTO ride_platform.notifications (
    id, ride_id, user_id, notification_type, notification_channel, 
    notification_status, sent_timestamp
)
SELECT 
    notification_id,
    ride_id,
    user_id,
    notification_type,
    notification_channel,
    notification_status,
    sent_timestamp
FROM ride_platform.staging_notifications
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- STEP 4: CLEANUP STAGING TABLES
-- ============================================================
DROP TABLE IF EXISTS ride_platform.staging_auth;
DROP TABLE IF EXISTS ride_platform.staging_drivers;
DROP TABLE IF EXISTS ride_platform.staging_pricing;
DROP TABLE IF EXISTS ride_platform.staging_payments;
DROP TABLE IF EXISTS ride_platform.staging_notifications;

-- ============================================================
-- STEP 5: ANALYZE TABLES FOR QUERY OPTIMIZATION
-- ============================================================
ANALYZE ride_platform.users;
ANALYZE ride_platform.drivers;
ANALYZE ride_platform.rides;
ANALYZE ride_platform.authentication;
ANALYZE ride_platform.pricing;
ANALYZE ride_platform.payments;
ANALYZE ride_platform.revenue;
ANALYZE ride_platform.notifications;

-- ============================================================
-- IMPORT COMPLETE
-- ============================================================
