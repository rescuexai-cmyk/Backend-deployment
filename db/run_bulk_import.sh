#!/bin/bash
# ============================================================
# RAAHI PLATFORM - BULK DATA IMPORT SCRIPT
# ============================================================
# This script imports CSV data into the ride_platform schema
# Usage: ./run_bulk_import.sh
# ============================================================

set -e

echo "============================================"
echo "RAAHI PLATFORM - BULK DATA IMPORT"
echo "============================================"

# Configuration
DB_USER="${POSTGRES_USER:-raahi}"
DB_NAME="${POSTGRES_DB:-raahi}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# CSV file directory - UPDATE THIS PATH
CSV_DIR="${CSV_DIR:-/tmp/csv_data}"

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "Configuration:"
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"
echo "  Host: $DB_HOST:$DB_PORT"
echo "  CSV Directory: $CSV_DIR"
echo ""

# Check if CSV files exist
if [ ! -d "$CSV_DIR" ]; then
    echo "ERROR: CSV directory not found: $CSV_DIR"
    echo "Please set CSV_DIR environment variable or copy files to /tmp/csv_data"
    exit 1
fi

# Check required files
REQUIRED_FILES=(
    "authentication_service_data.csv"
    "driver_service_data.csv"
    "pricing_service_data.csv"
    "payment_service_data.csv"
    "notification_service_data.csv"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$CSV_DIR/$file" ]; then
        echo "ERROR: Required file not found: $CSV_DIR/$file"
        exit 1
    fi
done

echo "✓ All required CSV files found"
echo ""

# Function to run SQL file
run_sql() {
    local file="$1"
    local description="$2"
    echo "Running: $description..."
    PGPASSWORD="${POSTGRES_PASSWORD:-raahi_prod_2024_secure}" psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -f "$file" \
        -v ON_ERROR_STOP=1
    echo "✓ $description complete"
    echo ""
}

# Function to run SQL command
run_cmd() {
    local cmd="$1"
    PGPASSWORD="${POSTGRES_PASSWORD:-raahi_prod_2024_secure}" psql \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -c "$cmd"
}

# Step 1: Create schema and tables
echo "============================================"
echo "STEP 1: Creating Schema and Tables"
echo "============================================"
run_sql "$SCRIPT_DIR/bulk_import_schema.sql" "Schema creation"

# Step 2: Create staging tables and import CSV data
echo "============================================"
echo "STEP 2: Importing CSV Data"
echo "============================================"

# Create staging tables
echo "Creating staging tables..."
run_cmd "
SET search_path TO ride_platform, public;

DROP TABLE IF EXISTS ride_platform.staging_auth;
CREATE TABLE ride_platform.staging_auth (
    auth_id TEXT, user_id TEXT, ride_id TEXT, 
    login_method TEXT, authentication_status TEXT, last_login TIMESTAMPTZ
);

DROP TABLE IF EXISTS ride_platform.staging_drivers;
CREATE TABLE ride_platform.staging_drivers (
    driver_id TEXT, ride_id TEXT, driver_name TEXT, 
    driver_rating NUMERIC, vehicle_number TEXT, vehicle_type TEXT, driver_status TEXT
);

DROP TABLE IF EXISTS ride_platform.staging_pricing;
CREATE TABLE ride_platform.staging_pricing (
    pricing_id TEXT, ride_id TEXT, base_fare NUMERIC, 
    distance_charge NUMERIC, time_charge NUMERIC, surge_multiplier NUMERIC, total_price NUMERIC
);

DROP TABLE IF EXISTS ride_platform.staging_payments;
CREATE TABLE ride_platform.staging_payments (
    payment_id TEXT, ride_id TEXT, payment_method TEXT, 
    payment_status TEXT, transaction_id TEXT, payment_timestamp TIMESTAMPTZ
);

DROP TABLE IF EXISTS ride_platform.staging_notifications;
CREATE TABLE ride_platform.staging_notifications (
    notification_id TEXT, ride_id TEXT, user_id TEXT, notification_type TEXT, 
    notification_channel TEXT, notification_status TEXT, sent_timestamp TIMESTAMPTZ
);
"
echo "✓ Staging tables created"

# Import CSV files using \COPY
echo ""
echo "Importing authentication_service_data.csv..."
PGPASSWORD="${POSTGRES_PASSWORD:-raahi_prod_2024_secure}" psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -c "\COPY ride_platform.staging_auth FROM '$CSV_DIR/authentication_service_data.csv' WITH (FORMAT csv, HEADER true)"

echo "Importing driver_service_data.csv..."
PGPASSWORD="${POSTGRES_PASSWORD:-raahi_prod_2024_secure}" psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -c "\COPY ride_platform.staging_drivers FROM '$CSV_DIR/driver_service_data.csv' WITH (FORMAT csv, HEADER true)"

echo "Importing pricing_service_data.csv..."
PGPASSWORD="${POSTGRES_PASSWORD:-raahi_prod_2024_secure}" psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -c "\COPY ride_platform.staging_pricing FROM '$CSV_DIR/pricing_service_data.csv' WITH (FORMAT csv, HEADER true)"

echo "Importing payment_service_data.csv..."
PGPASSWORD="${POSTGRES_PASSWORD:-raahi_prod_2024_secure}" psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -c "\COPY ride_platform.staging_payments FROM '$CSV_DIR/payment_service_data.csv' WITH (FORMAT csv, HEADER true)"

echo "Importing notification_service_data.csv..."
PGPASSWORD="${POSTGRES_PASSWORD:-raahi_prod_2024_secure}" psql \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -c "\COPY ride_platform.staging_notifications FROM '$CSV_DIR/notification_service_data.csv' WITH (FORMAT csv, HEADER true)"

echo "✓ All CSV files imported to staging tables"

# Step 3: Transform and load into normalized tables
echo ""
echo "============================================"
echo "STEP 3: Transforming Data to Normalized Tables"
echo "============================================"

run_cmd "
SET search_path TO ride_platform, public;

-- Insert users
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

-- Insert drivers
INSERT INTO ride_platform.drivers (id, name, rating, vehicle_number, vehicle_type, status, created_at)
SELECT DISTINCT ON (sd.driver_id)
    sd.driver_id, sd.driver_name, sd.driver_rating, sd.vehicle_number, sd.vehicle_type,
    CASE WHEN sd.driver_status = 'Active' THEN 'active'
         WHEN sd.driver_status = 'Inactive' THEN 'inactive'
         WHEN sd.driver_status = 'Suspended' THEN 'suspended'
         ELSE 'inactive' END as status,
    NOW() as created_at
FROM ride_platform.staging_drivers sd
ON CONFLICT (id) DO NOTHING;

-- Insert rides
INSERT INTO ride_platform.rides (id, user_id, driver_id, base_fare, distance_fare, time_fare, 
    surge_multiplier, total_fare, payment_method, payment_status, status, created_at)
SELECT DISTINCT ON (sp.ride_id)
    sp.ride_id, sa.user_id, sd.driver_id, spr.base_fare, spr.distance_charge, spr.time_charge,
    spr.surge_multiplier, spr.total_price, sp.payment_method,
    CASE WHEN sp.payment_status = 'Completed' THEN 'paid'
         WHEN sp.payment_status = 'Failed' THEN 'failed' ELSE 'pending' END,
    CASE WHEN sp.payment_status = 'Completed' THEN 'completed' ELSE 'pending' END,
    COALESCE(sp.payment_timestamp, NOW())
FROM ride_platform.staging_payments sp
LEFT JOIN ride_platform.staging_auth sa ON sp.ride_id = sa.ride_id
LEFT JOIN ride_platform.staging_drivers sd ON sp.ride_id = sd.ride_id
LEFT JOIN ride_platform.staging_pricing spr ON sp.ride_id = spr.ride_id
ON CONFLICT (id) DO NOTHING;
"

echo "✓ Users, Drivers, and Rides loaded"

run_cmd "
SET search_path TO ride_platform, public;

-- Insert authentication records
INSERT INTO ride_platform.authentication (id, user_id, ride_id, login_method, authentication_status, last_login)
SELECT auth_id, user_id, ride_id, login_method, authentication_status, last_login
FROM ride_platform.staging_auth ON CONFLICT (id) DO NOTHING;

-- Insert pricing records
INSERT INTO ride_platform.pricing (id, ride_id, base_fare, distance_charge, time_charge, surge_multiplier, total_price)
SELECT pricing_id, ride_id, base_fare, distance_charge, time_charge, surge_multiplier, total_price
FROM ride_platform.staging_pricing ON CONFLICT (id) DO NOTHING;

-- Insert payment records
INSERT INTO ride_platform.payments (id, ride_id, amount, payment_method, payment_status, transaction_id, payment_timestamp)
SELECT payment_id, ride_id, 
    (SELECT total_price FROM ride_platform.staging_pricing WHERE ride_id = sp.ride_id LIMIT 1),
    payment_method, payment_status, transaction_id, payment_timestamp
FROM ride_platform.staging_payments sp ON CONFLICT (id) DO NOTHING;

-- Insert revenue records
INSERT INTO ride_platform.revenue (id, ride_id, payment_id, gross_amount, commission_amount, 
    commission_rate, driver_payout, platform_fee, net_revenue)
SELECT 'REV' || SUBSTRING(sp.payment_id FROM 4), sp.ride_id, sp.payment_id, spr.total_price,
    ROUND(spr.total_price * 0.20, 2), 0.20, ROUND(spr.total_price * 0.80, 2),
    ROUND(spr.total_price * 0.02, 2), ROUND(spr.total_price * 0.22, 2)
FROM ride_platform.staging_payments sp
JOIN ride_platform.staging_pricing spr ON sp.ride_id = spr.ride_id
WHERE sp.payment_status = 'Completed' ON CONFLICT (id) DO NOTHING;

-- Insert notification records
INSERT INTO ride_platform.notifications (id, ride_id, user_id, notification_type, 
    notification_channel, notification_status, sent_timestamp)
SELECT notification_id, ride_id, user_id, notification_type, notification_channel, 
    notification_status, sent_timestamp
FROM ride_platform.staging_notifications ON CONFLICT (id) DO NOTHING;
"

echo "✓ All data loaded into normalized tables"

# Step 4: Cleanup
echo ""
echo "============================================"
echo "STEP 4: Cleanup & Optimization"
echo "============================================"

run_cmd "
SET search_path TO ride_platform, public;
DROP TABLE IF EXISTS ride_platform.staging_auth;
DROP TABLE IF EXISTS ride_platform.staging_drivers;
DROP TABLE IF EXISTS ride_platform.staging_pricing;
DROP TABLE IF EXISTS ride_platform.staging_payments;
DROP TABLE IF EXISTS ride_platform.staging_notifications;

ANALYZE ride_platform.users;
ANALYZE ride_platform.drivers;
ANALYZE ride_platform.rides;
ANALYZE ride_platform.authentication;
ANALYZE ride_platform.pricing;
ANALYZE ride_platform.payments;
ANALYZE ride_platform.revenue;
ANALYZE ride_platform.notifications;
"

echo "✓ Staging tables dropped and tables analyzed"

# Step 5: Validation
echo ""
echo "============================================"
echo "STEP 5: Validation Results"
echo "============================================"

run_cmd "
SET search_path TO ride_platform, public;
SELECT 'users' as table_name, COUNT(*) as row_count FROM ride_platform.users
UNION ALL SELECT 'drivers', COUNT(*) FROM ride_platform.drivers
UNION ALL SELECT 'rides', COUNT(*) FROM ride_platform.rides
UNION ALL SELECT 'authentication', COUNT(*) FROM ride_platform.authentication
UNION ALL SELECT 'pricing', COUNT(*) FROM ride_platform.pricing
UNION ALL SELECT 'payments', COUNT(*) FROM ride_platform.payments
UNION ALL SELECT 'revenue', COUNT(*) FROM ride_platform.revenue
UNION ALL SELECT 'notifications', COUNT(*) FROM ride_platform.notifications
ORDER BY table_name;
"

echo ""
echo "============================================"
echo "IMPORT COMPLETE!"
echo "============================================"
echo ""
echo "Run validation queries:"
echo "  psql -U $DB_USER -d $DB_NAME -f $SCRIPT_DIR/bulk_import_validation.sql"
echo ""
