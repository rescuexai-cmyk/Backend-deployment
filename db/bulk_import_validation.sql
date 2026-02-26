-- ============================================================
-- RAAHI PLATFORM - DATA VALIDATION QUERIES
-- ============================================================
-- Run this AFTER bulk_import_data.sql to validate data integrity
-- ============================================================

SET search_path TO ride_platform, public;

-- ============================================================
-- VALIDATION 1: ROW COUNTS PER TABLE
-- ============================================================
SELECT '=== ROW COUNTS ===' as section;

SELECT 'users' as table_name, COUNT(*) as row_count FROM ride_platform.users
UNION ALL
SELECT 'drivers', COUNT(*) FROM ride_platform.drivers
UNION ALL
SELECT 'rides', COUNT(*) FROM ride_platform.rides
UNION ALL
SELECT 'authentication', COUNT(*) FROM ride_platform.authentication
UNION ALL
SELECT 'pricing', COUNT(*) FROM ride_platform.pricing
UNION ALL
SELECT 'payments', COUNT(*) FROM ride_platform.payments
UNION ALL
SELECT 'revenue', COUNT(*) FROM ride_platform.revenue
UNION ALL
SELECT 'notifications', COUNT(*) FROM ride_platform.notifications
ORDER BY table_name;

-- ============================================================
-- VALIDATION 2: CHECK FOR DUPLICATE PRIMARY KEYS
-- ============================================================
SELECT '=== DUPLICATE CHECK ===' as section;

SELECT 'users' as table_name, COUNT(*) as duplicate_count 
FROM (SELECT id FROM ride_platform.users GROUP BY id HAVING COUNT(*) > 1) t
UNION ALL
SELECT 'drivers', COUNT(*) FROM (SELECT id FROM ride_platform.drivers GROUP BY id HAVING COUNT(*) > 1) t
UNION ALL
SELECT 'rides', COUNT(*) FROM (SELECT id FROM ride_platform.rides GROUP BY id HAVING COUNT(*) > 1) t
UNION ALL
SELECT 'authentication', COUNT(*) FROM (SELECT id FROM ride_platform.authentication GROUP BY id HAVING COUNT(*) > 1) t
UNION ALL
SELECT 'pricing', COUNT(*) FROM (SELECT id FROM ride_platform.pricing GROUP BY id HAVING COUNT(*) > 1) t
UNION ALL
SELECT 'payments', COUNT(*) FROM (SELECT id FROM ride_platform.payments GROUP BY id HAVING COUNT(*) > 1) t;

-- ============================================================
-- VALIDATION 3: CHECK FOR ORPHAN RECORDS
-- ============================================================
SELECT '=== ORPHAN RECORDS CHECK ===' as section;

-- Rides without valid users
SELECT 'rides_without_users' as check_name, COUNT(*) as orphan_count
FROM ride_platform.rides r
WHERE r.user_id IS NOT NULL 
  AND NOT EXISTS (SELECT 1 FROM ride_platform.users u WHERE u.id = r.user_id);

-- Rides without valid drivers
SELECT 'rides_without_drivers' as check_name, COUNT(*) as orphan_count
FROM ride_platform.rides r
WHERE r.driver_id IS NOT NULL 
  AND NOT EXISTS (SELECT 1 FROM ride_platform.drivers d WHERE d.id = r.driver_id);

-- Payments without valid rides
SELECT 'payments_without_rides' as check_name, COUNT(*) as orphan_count
FROM ride_platform.payments p
WHERE NOT EXISTS (SELECT 1 FROM ride_platform.rides r WHERE r.id = p.ride_id);

-- Pricing without valid rides
SELECT 'pricing_without_rides' as check_name, COUNT(*) as orphan_count
FROM ride_platform.pricing p
WHERE NOT EXISTS (SELECT 1 FROM ride_platform.rides r WHERE r.id = p.ride_id);

-- Notifications without valid users
SELECT 'notifications_without_users' as check_name, COUNT(*) as orphan_count
FROM ride_platform.notifications n
WHERE NOT EXISTS (SELECT 1 FROM ride_platform.users u WHERE u.id = n.user_id);

-- ============================================================
-- VALIDATION 4: CHECK FOR DUPLICATE EMAILS
-- ============================================================
SELECT '=== DUPLICATE EMAILS ===' as section;

SELECT email, COUNT(*) as count
FROM ride_platform.users
WHERE email IS NOT NULL
GROUP BY email
HAVING COUNT(*) > 1
LIMIT 10;

-- ============================================================
-- VALIDATION 5: DATA QUALITY CHECKS
-- ============================================================
SELECT '=== DATA QUALITY ===' as section;

-- Driver rating distribution
SELECT 'driver_rating_distribution' as metric,
       MIN(rating) as min_rating,
       MAX(rating) as max_rating,
       ROUND(AVG(rating)::numeric, 2) as avg_rating
FROM ride_platform.drivers;

-- Payment status distribution
SELECT payment_status, COUNT(*) as count
FROM ride_platform.payments
GROUP BY payment_status
ORDER BY count DESC;

-- Driver status distribution
SELECT status, COUNT(*) as count
FROM ride_platform.drivers
GROUP BY status
ORDER BY count DESC;

-- Vehicle type distribution
SELECT vehicle_type, COUNT(*) as count
FROM ride_platform.drivers
GROUP BY vehicle_type
ORDER BY count DESC;

-- Login method distribution
SELECT login_method, COUNT(*) as count
FROM ride_platform.authentication
GROUP BY login_method
ORDER BY count DESC;

-- Notification channel distribution
SELECT notification_channel, COUNT(*) as count
FROM ride_platform.notifications
GROUP BY notification_channel
ORDER BY count DESC;

-- ============================================================
-- VALIDATION 6: FINANCIAL INTEGRITY
-- ============================================================
SELECT '=== FINANCIAL INTEGRITY ===' as section;

-- Total fare distribution
SELECT 
    'pricing_stats' as metric,
    ROUND(MIN(total_price)::numeric, 2) as min_fare,
    ROUND(MAX(total_price)::numeric, 2) as max_fare,
    ROUND(AVG(total_price)::numeric, 2) as avg_fare,
    ROUND(SUM(total_price)::numeric, 2) as total_gmv
FROM ride_platform.pricing;

-- Revenue stats
SELECT 
    'revenue_stats' as metric,
    ROUND(SUM(gross_amount)::numeric, 2) as total_gmv,
    ROUND(SUM(commission_amount)::numeric, 2) as total_commission,
    ROUND(SUM(driver_payout)::numeric, 2) as total_driver_payout,
    ROUND(SUM(net_revenue)::numeric, 2) as platform_revenue
FROM ride_platform.revenue;

-- ============================================================
-- VALIDATION 7: FOREIGN KEY INTEGRITY
-- ============================================================
SELECT '=== FK INTEGRITY ===' as section;

-- Check all FKs are valid
SELECT 'rides.user_id -> users.id' as fk_check,
       COUNT(*) as invalid_count
FROM ride_platform.rides r
LEFT JOIN ride_platform.users u ON r.user_id = u.id
WHERE r.user_id IS NOT NULL AND u.id IS NULL;

SELECT 'rides.driver_id -> drivers.id' as fk_check,
       COUNT(*) as invalid_count
FROM ride_platform.rides r
LEFT JOIN ride_platform.drivers d ON r.driver_id = d.id
WHERE r.driver_id IS NOT NULL AND d.id IS NULL;

SELECT 'pricing.ride_id -> rides.id' as fk_check,
       COUNT(*) as invalid_count
FROM ride_platform.pricing p
LEFT JOIN ride_platform.rides r ON p.ride_id = r.id
WHERE r.id IS NULL;

SELECT 'payments.ride_id -> rides.id' as fk_check,
       COUNT(*) as invalid_count
FROM ride_platform.payments p
LEFT JOIN ride_platform.rides r ON p.ride_id = r.id
WHERE r.id IS NULL;

-- ============================================================
-- VALIDATION 8: INDEX USAGE CHECK
-- ============================================================
SELECT '=== INDEX CHECK ===' as section;

SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan as index_scans,
    idx_tup_read as tuples_read,
    idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes
WHERE schemaname = 'ride_platform'
ORDER BY tablename, indexname;

-- ============================================================
-- VALIDATION SUMMARY
-- ============================================================
SELECT '=== VALIDATION COMPLETE ===' as section;

SELECT 
    'Total Records Imported' as metric,
    (SELECT COUNT(*) FROM ride_platform.users) +
    (SELECT COUNT(*) FROM ride_platform.drivers) +
    (SELECT COUNT(*) FROM ride_platform.rides) +
    (SELECT COUNT(*) FROM ride_platform.authentication) +
    (SELECT COUNT(*) FROM ride_platform.pricing) +
    (SELECT COUNT(*) FROM ride_platform.payments) +
    (SELECT COUNT(*) FROM ride_platform.revenue) +
    (SELECT COUNT(*) FROM ride_platform.notifications) as total_count;
