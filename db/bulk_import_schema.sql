-- ============================================================
-- RAAHI PLATFORM - BULK DATA IMPORT SCHEMA
-- ============================================================
-- This schema is for importing CSV data into PostgreSQL
-- It creates a separate 'ride_platform' schema to avoid 
-- conflicts with the Prisma-managed main schema
-- ============================================================
-- Created: 2026-02-25
-- Data: 250,000 records across 5 CSV files
-- ============================================================

-- ============================================================
-- STEP 1: CREATE SCHEMA
-- ============================================================
CREATE SCHEMA IF NOT EXISTS ride_platform;

-- Set search path
SET search_path TO ride_platform, public;

-- ============================================================
-- STEP 2: DROP EXISTING TABLES (if re-running)
-- ============================================================
DROP TABLE IF EXISTS ride_platform.notifications CASCADE;
DROP TABLE IF EXISTS ride_platform.payments CASCADE;
DROP TABLE IF EXISTS ride_platform.pricing CASCADE;
DROP TABLE IF EXISTS ride_platform.authentication CASCADE;
DROP TABLE IF EXISTS ride_platform.rides CASCADE;
DROP TABLE IF EXISTS ride_platform.drivers CASCADE;
DROP TABLE IF EXISTS ride_platform.users CASCADE;
DROP TABLE IF EXISTS ride_platform.revenue CASCADE;

-- ============================================================
-- STEP 3: CREATE NORMALIZED TABLES
-- ============================================================

-- -----------------------------
-- USERS TABLE
-- Extracted from authentication_service_data.csv
-- -----------------------------
CREATE TABLE ride_platform.users (
    id              TEXT PRIMARY KEY,           -- e.g., U1000
    name            VARCHAR(100),
    email           VARCHAR(255) UNIQUE,
    phone           VARCHAR(20),
    role            VARCHAR(20) DEFAULT 'rider',  -- rider, driver, admin
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ride_platform.users IS 'User accounts for riders and admins';

-- -----------------------------
-- DRIVERS TABLE
-- From driver_service_data.csv
-- -----------------------------
CREATE TABLE ride_platform.drivers (
    id                  TEXT PRIMARY KEY,       -- e.g., D1000
    user_id             TEXT,                   -- FK to users (nullable for CSV import)
    name                VARCHAR(100) NOT NULL,
    rating              NUMERIC(3,2) DEFAULT 0.00,
    rating_count        INT DEFAULT 0,
    vehicle_number      VARCHAR(20),
    vehicle_type        VARCHAR(30),            -- SUV, Auto, Mini, Sedan, Bike
    vehicle_model       VARCHAR(100),
    vehicle_color       VARCHAR(30),
    status              VARCHAR(20) DEFAULT 'inactive',  -- active, inactive, suspended
    is_verified         BOOLEAN DEFAULT false,
    is_online           BOOLEAN DEFAULT false,
    total_rides         INT DEFAULT 0,
    total_earnings      NUMERIC(12,2) DEFAULT 0.00,
    current_latitude    DOUBLE PRECISION,
    current_longitude   DOUBLE PRECISION,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ride_platform.drivers IS 'Driver profiles with vehicle information';

-- -----------------------------
-- RIDES TABLE
-- Derived from ride_id across all CSVs
-- -----------------------------
CREATE TABLE ride_platform.rides (
    id                  TEXT PRIMARY KEY,       -- e.g., RD3161218751875354
    user_id             TEXT,                   -- FK to users
    driver_id           TEXT,                   -- FK to drivers
    pickup_location     TEXT,
    pickup_latitude     DOUBLE PRECISION,
    pickup_longitude    DOUBLE PRECISION,
    drop_location       TEXT,
    drop_latitude       DOUBLE PRECISION,
    drop_longitude      DOUBLE PRECISION,
    distance_km         NUMERIC(10,2),
    duration_minutes    INT,
    base_fare           NUMERIC(10,2),
    distance_fare       NUMERIC(10,2),
    time_fare           NUMERIC(10,2),
    surge_multiplier    NUMERIC(4,2) DEFAULT 1.00,
    surge_fare          NUMERIC(10,2) DEFAULT 0.00,
    total_fare          NUMERIC(10,2),
    status              VARCHAR(30) DEFAULT 'pending',  -- pending, confirmed, in_progress, completed, cancelled
    payment_method      VARCHAR(20),            -- Cash, UPI, Card, Wallet
    payment_status      VARCHAR(20) DEFAULT 'pending',  -- pending, completed, failed, refunded
    ride_otp            VARCHAR(6),
    scheduled_at        TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    cancelled_by        VARCHAR(20),
    cancellation_reason TEXT,
    passenger_rating    INT CHECK (passenger_rating >= 1 AND passenger_rating <= 5),
    driver_rating       INT CHECK (driver_rating >= 1 AND driver_rating <= 5),
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ride_platform.rides IS 'Core ride bookings and trip details';

-- -----------------------------
-- AUTHENTICATION TABLE
-- From authentication_service_data.csv
-- -----------------------------
CREATE TABLE ride_platform.authentication (
    id                      TEXT PRIMARY KEY,   -- e.g., AUTH1000
    user_id                 TEXT NOT NULL,      -- FK to users
    ride_id                 TEXT,               -- FK to rides (session context)
    login_method            VARCHAR(30),        -- Phone, Google, Facebook, Apple
    authentication_status   VARCHAR(20),        -- Success, Failed
    last_login              TIMESTAMPTZ,
    ip_address              VARCHAR(45),
    device_info             TEXT,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ride_platform.authentication IS 'User authentication sessions and login history';

-- -----------------------------
-- PRICING TABLE
-- From pricing_service_data.csv
-- -----------------------------
CREATE TABLE ride_platform.pricing (
    id                  TEXT PRIMARY KEY,       -- e.g., P1000
    ride_id             TEXT NOT NULL UNIQUE,   -- FK to rides
    base_fare           NUMERIC(10,2) NOT NULL,
    distance_charge     NUMERIC(10,2) NOT NULL,
    time_charge         NUMERIC(10,2) NOT NULL,
    surge_multiplier    NUMERIC(4,2) DEFAULT 1.00,
    total_price         NUMERIC(10,2) NOT NULL,
    discount_amount     NUMERIC(10,2) DEFAULT 0.00,
    promo_code          VARCHAR(50),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ride_platform.pricing IS 'Ride pricing breakdown and fare calculation';

-- -----------------------------
-- PAYMENTS TABLE
-- From payment_service_data.csv
-- -----------------------------
CREATE TABLE ride_platform.payments (
    id                  TEXT PRIMARY KEY,       -- e.g., PAY1000
    ride_id             TEXT NOT NULL UNIQUE,   -- FK to rides
    amount              NUMERIC(10,2) NOT NULL,
    payment_method      VARCHAR(20) NOT NULL,   -- Cash, UPI, Card, Wallet
    payment_status      VARCHAR(20) NOT NULL,   -- Pending, Completed, Failed, Refunded
    transaction_id      VARCHAR(100),           -- External payment gateway reference
    payment_gateway     VARCHAR(50),            -- Razorpay, Paytm, etc.
    payment_timestamp   TIMESTAMPTZ,
    refund_amount       NUMERIC(10,2),
    refund_timestamp    TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ride_platform.payments IS 'Payment transactions for rides';

-- -----------------------------
-- REVENUE TABLE
-- Derived from pricing/payments for platform earnings
-- -----------------------------
CREATE TABLE ride_platform.revenue (
    id                  TEXT PRIMARY KEY,
    ride_id             TEXT NOT NULL UNIQUE,   -- FK to rides
    payment_id          TEXT,                   -- FK to payments
    gross_amount        NUMERIC(10,2) NOT NULL, -- Total fare
    commission_amount   NUMERIC(10,2) NOT NULL, -- Platform commission
    commission_rate     NUMERIC(4,2) DEFAULT 0.20, -- 20% default
    driver_payout       NUMERIC(10,2) NOT NULL, -- Driver's share
    platform_fee        NUMERIC(10,2) DEFAULT 0.00,
    tax_amount          NUMERIC(10,2) DEFAULT 0.00,
    net_revenue         NUMERIC(10,2) NOT NULL, -- commission + platform_fee
    settlement_status   VARCHAR(20) DEFAULT 'pending', -- pending, settled
    settlement_date     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ride_platform.revenue IS 'Platform revenue and commission tracking';

-- -----------------------------
-- NOTIFICATIONS TABLE
-- From notification_service_data.csv
-- -----------------------------
CREATE TABLE ride_platform.notifications (
    id                      TEXT PRIMARY KEY,   -- e.g., N1000
    ride_id                 TEXT,               -- FK to rides
    user_id                 TEXT NOT NULL,      -- FK to users
    notification_type       VARCHAR(50),        -- Ride Confirmation, Payment Receipt, Driver Assigned, etc.
    notification_channel    VARCHAR(30),        -- Push Notification, SMS, Email
    notification_status     VARCHAR(20),        -- Sent, Delivered, Failed
    title                   VARCHAR(255),
    message                 TEXT,
    data                    JSONB,
    sent_timestamp          TIMESTAMPTZ,
    delivered_timestamp     TIMESTAMPTZ,
    read_at                 TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE ride_platform.notifications IS 'User notifications across channels';

-- ============================================================
-- STEP 4: ADD FOREIGN KEY CONSTRAINTS
-- ============================================================

-- Note: We add these AFTER data import to improve bulk load performance
-- Run these after COPY commands complete

-- ALTER TABLE ride_platform.drivers 
--     ADD CONSTRAINT fk_drivers_user FOREIGN KEY (user_id) REFERENCES ride_platform.users(id) ON DELETE SET NULL;

ALTER TABLE ride_platform.rides 
    ADD CONSTRAINT fk_rides_user FOREIGN KEY (user_id) REFERENCES ride_platform.users(id) ON DELETE SET NULL;

ALTER TABLE ride_platform.rides 
    ADD CONSTRAINT fk_rides_driver FOREIGN KEY (driver_id) REFERENCES ride_platform.drivers(id) ON DELETE SET NULL;

ALTER TABLE ride_platform.authentication 
    ADD CONSTRAINT fk_auth_user FOREIGN KEY (user_id) REFERENCES ride_platform.users(id) ON DELETE CASCADE;

ALTER TABLE ride_platform.authentication 
    ADD CONSTRAINT fk_auth_ride FOREIGN KEY (ride_id) REFERENCES ride_platform.rides(id) ON DELETE SET NULL;

ALTER TABLE ride_platform.pricing 
    ADD CONSTRAINT fk_pricing_ride FOREIGN KEY (ride_id) REFERENCES ride_platform.rides(id) ON DELETE CASCADE;

ALTER TABLE ride_platform.payments 
    ADD CONSTRAINT fk_payments_ride FOREIGN KEY (ride_id) REFERENCES ride_platform.rides(id) ON DELETE CASCADE;

ALTER TABLE ride_platform.revenue 
    ADD CONSTRAINT fk_revenue_ride FOREIGN KEY (ride_id) REFERENCES ride_platform.rides(id) ON DELETE CASCADE;

ALTER TABLE ride_platform.revenue 
    ADD CONSTRAINT fk_revenue_payment FOREIGN KEY (payment_id) REFERENCES ride_platform.payments(id) ON DELETE SET NULL;

ALTER TABLE ride_platform.notifications 
    ADD CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES ride_platform.users(id) ON DELETE CASCADE;

ALTER TABLE ride_platform.notifications 
    ADD CONSTRAINT fk_notifications_ride FOREIGN KEY (ride_id) REFERENCES ride_platform.rides(id) ON DELETE SET NULL;

-- ============================================================
-- STEP 5: CREATE INDEXES FOR PERFORMANCE
-- ============================================================

-- Users indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON ride_platform.users(email);
CREATE INDEX IF NOT EXISTS idx_users_phone ON ride_platform.users(phone);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON ride_platform.users(created_at);

-- Drivers indexes
CREATE INDEX IF NOT EXISTS idx_drivers_user_id ON ride_platform.drivers(user_id);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON ride_platform.drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_vehicle_type ON ride_platform.drivers(vehicle_type);
CREATE INDEX IF NOT EXISTS idx_drivers_rating ON ride_platform.drivers(rating DESC);
CREATE INDEX IF NOT EXISTS idx_drivers_location ON ride_platform.drivers(current_latitude, current_longitude);

-- Rides indexes (critical for performance)
CREATE INDEX IF NOT EXISTS idx_rides_user_id ON ride_platform.rides(user_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver_id ON ride_platform.rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_status ON ride_platform.rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_created_at ON ride_platform.rides(created_at);
CREATE INDEX IF NOT EXISTS idx_rides_payment_status ON ride_platform.rides(payment_status);
CREATE INDEX IF NOT EXISTS idx_rides_user_status ON ride_platform.rides(user_id, status);
CREATE INDEX IF NOT EXISTS idx_rides_driver_status ON ride_platform.rides(driver_id, status);

-- Authentication indexes
CREATE INDEX IF NOT EXISTS idx_auth_user_id ON ride_platform.authentication(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_ride_id ON ride_platform.authentication(ride_id);
CREATE INDEX IF NOT EXISTS idx_auth_last_login ON ride_platform.authentication(last_login);
CREATE INDEX IF NOT EXISTS idx_auth_method ON ride_platform.authentication(login_method);

-- Pricing indexes
CREATE INDEX IF NOT EXISTS idx_pricing_ride_id ON ride_platform.pricing(ride_id);

-- Payments indexes
CREATE INDEX IF NOT EXISTS idx_payments_ride_id ON ride_platform.payments(ride_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON ride_platform.payments(payment_status);
CREATE INDEX IF NOT EXISTS idx_payments_method ON ride_platform.payments(payment_method);
CREATE INDEX IF NOT EXISTS idx_payments_timestamp ON ride_platform.payments(payment_timestamp);
CREATE INDEX IF NOT EXISTS idx_payments_transaction_id ON ride_platform.payments(transaction_id);

-- Revenue indexes
CREATE INDEX IF NOT EXISTS idx_revenue_ride_id ON ride_platform.revenue(ride_id);
CREATE INDEX IF NOT EXISTS idx_revenue_settlement ON ride_platform.revenue(settlement_status);
CREATE INDEX IF NOT EXISTS idx_revenue_created_at ON ride_platform.revenue(created_at);

-- Notifications indexes
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON ride_platform.notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_ride_id ON ride_platform.notifications(ride_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON ride_platform.notifications(notification_status);
CREATE INDEX IF NOT EXISTS idx_notifications_type ON ride_platform.notifications(notification_type);
CREATE INDEX IF NOT EXISTS idx_notifications_sent ON ride_platform.notifications(sent_timestamp);

-- ============================================================
-- SCHEMA COMPLETE
-- ============================================================
-- Tables: 8
-- Indexes: 30+
-- Foreign Keys: 10
-- ============================================================
