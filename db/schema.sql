-- Raahi Backend — PostgreSQL Schema
-- Designed for Neon/Vercel Postgres compatibility

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- USERS  (both riders and drivers share the same identity table)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone         VARCHAR(20) UNIQUE NOT NULL,
  name          VARCHAR(100) NOT NULL DEFAULT 'User',
  email         VARCHAR(255),
  avatar_url    TEXT,
  user_type     VARCHAR(10) NOT NULL DEFAULT 'rider'
                  CHECK (user_type IN ('rider', 'driver', 'both')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- DRIVERS  (1-to-1 extension of users for driver-specific data)
-- ============================================================
CREATE TABLE IF NOT EXISTS drivers (
  id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  license_number  VARCHAR(50),
  vehicle_make    VARCHAR(50),
  vehicle_model   VARCHAR(50),
  vehicle_year    INT,
  vehicle_color   VARCHAR(30),
  vehicle_plate   VARCHAR(20),
  vehicle_type    VARCHAR(20) NOT NULL DEFAULT 'economy'
                    CHECK (vehicle_type IN ('economy','comfort','premium','xl','bike')),
  is_verified     BOOLEAN NOT NULL DEFAULT false,
  is_available    BOOLEAN NOT NULL DEFAULT false,
  status          VARCHAR(20) NOT NULL DEFAULT 'offline'
                    CHECK (status IN ('available','busy','offline','on_ride')),
  rating          DECIMAL(3,2) NOT NULL DEFAULT 4.00,
  total_rides     INT NOT NULL DEFAULT 0,
  current_lat     DECIMAL(10,7),
  current_lng     DECIMAL(10,7),
  heading         DECIMAL(5,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- SESSIONS  (auth tokens — one user can have multiple sessions)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       VARCHAR(500) UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

-- ============================================================
-- RIDES
-- ============================================================
CREATE TABLE IF NOT EXISTS rides (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rider_id          UUID REFERENCES users(id),
  driver_id         UUID REFERENCES drivers(id),
  rider_name        VARCHAR(100),
  rider_phone       VARCHAR(20),
  pickup_lat        DECIMAL(10,7),
  pickup_lng        DECIMAL(10,7),
  pickup_address    TEXT,
  dest_lat          DECIMAL(10,7),
  dest_lng          DECIMAL(10,7),
  dest_address      TEXT,
  distance          DECIMAL(10,2),          -- km
  duration          INT,                     -- minutes
  fare              DECIMAL(10,2),
  earning           DECIMAL(10,2),
  ride_type         VARCHAR(30) NOT NULL DEFAULT 'standard',
  payment_method    VARCHAR(20) NOT NULL DEFAULT 'cash',
  otp               VARCHAR(6),
  status            VARCHAR(30) NOT NULL DEFAULT 'searching_driver'
                      CHECK (status IN (
                        'searching_driver','accepted','driver_arriving',
                        'in_progress','completed','cancelled'
                      )),
  rating            DECIMAL(3,2),
  feedback          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at       TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- MESSAGES  (ride chat)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id       UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_id     UUID REFERENCES users(id),
  sender_role   VARCHAR(10) NOT NULL CHECK (sender_role IN ('rider','driver')),
  sender_name   VARCHAR(100),
  message       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- PAYMENTS
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ride_id         UUID REFERENCES rides(id),
  user_id         UUID REFERENCES users(id),
  amount          DECIMAL(10,2) NOT NULL,
  method          VARCHAR(20) NOT NULL DEFAULT 'cash',
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','completed','failed','refunded')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES  (critical for query performance at scale)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_users_phone         ON users(phone);
CREATE INDEX IF NOT EXISTS idx_sessions_token       ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id     ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_rides_status         ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_rider_id       ON rides(rider_id);
CREATE INDEX IF NOT EXISTS idx_rides_driver_id      ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_created_at     ON rides(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_ride_id     ON messages(ride_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at  ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_drivers_status       ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_available    ON drivers(is_available);
CREATE INDEX IF NOT EXISTS idx_payments_ride_id     ON payments(ride_id);
