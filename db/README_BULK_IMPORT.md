# Raahi Platform - Database Bulk Import

## Overview

This directory contains SQL scripts for creating the `ride_platform` schema and importing CSV data.

## Files

| File | Purpose |
|------|---------|
| `schema.sql` | Main Prisma-managed schema (DO NOT MODIFY) |
| `bulk_import_schema.sql` | Creates `ride_platform` schema and tables |
| `bulk_import_data.sql` | Imports CSV data into normalized tables |
| `bulk_import_validation.sql` | Validates data integrity after import |

## Data Summary

| CSV File | Rows | Description |
|----------|------|-------------|
| authentication_service_data.csv | 50,000 | User login sessions |
| driver_service_data.csv | 50,000 | Driver profiles |
| pricing_service_data.csv | 50,000 | Ride pricing breakdown |
| payment_service_data.csv | 50,000 | Payment transactions |
| notification_service_data.csv | 50,000 | User notifications |

**Total: 250,000 records**

## Schema Structure

```
ride_platform (schema)
├── users (50,000 rows)
├── drivers (50,000 rows)
├── rides (50,000 rows)
├── authentication (50,000 rows)
├── pricing (50,000 rows)
├── payments (50,000 rows)
├── revenue (~25,000 rows - completed payments only)
└── notifications (50,000 rows)
```

## How to Run

### Option 1: Using psql CLI

```bash
# Connect to your PostgreSQL database
psql -h localhost -U raahi -d raahi

# Step 1: Create schema and tables
\i /path/to/Backend-deployment/db/bulk_import_schema.sql

# Step 2: Import CSV data
\i /path/to/Backend-deployment/db/bulk_import_data.sql

# Step 3: Validate data
\i /path/to/Backend-deployment/db/bulk_import_validation.sql
```

### Option 2: Using Docker

```bash
# Copy CSV files to container
docker cp "/Users/anmolagarwal/Downloads/csv files of records" raahi-postgres:/tmp/csv_data

# Execute schema creation
docker exec -i raahi-postgres psql -U raahi -d raahi < db/bulk_import_schema.sql

# Update file paths in bulk_import_data.sql to /tmp/csv_data/
# Then run import
docker exec -i raahi-postgres psql -U raahi -d raahi < db/bulk_import_data.sql

# Run validation
docker exec -i raahi-postgres psql -U raahi -d raahi < db/bulk_import_validation.sql
```

### Option 3: Using pgAdmin

1. Open pgAdmin and connect to your database
2. Open Query Tool
3. Load and execute `bulk_import_schema.sql`
4. Load and execute `bulk_import_data.sql` (update file paths)
5. Load and execute `bulk_import_validation.sql`

## Expected Results

### Row Counts
```
users:          50,000
drivers:        50,000
rides:          50,000
authentication: 50,000
pricing:        50,000
payments:       50,000
revenue:        ~25,000 (completed payments only)
notifications:  50,000
```

### Validation Checks
- ✅ No duplicate primary keys
- ✅ No orphan records
- ✅ No duplicate emails
- ✅ Valid foreign key relationships
- ✅ All indexes created

## Tables & Relationships

```
users (1) ──────────────── (N) authentication
  │
  └──(1)────────────────── (N) rides
                              │
drivers (1) ────────────────┘
  │
  │ rides (1) ──── (1) pricing
  │        │
  │        └───── (1) payments ──── (1) revenue
  │
users (1) ──────────────── (N) notifications
```

## Indexes Created

| Table | Indexes |
|-------|---------|
| users | email, phone, created_at |
| drivers | user_id, status, vehicle_type, rating, location |
| rides | user_id, driver_id, status, created_at, payment_status |
| authentication | user_id, ride_id, last_login, login_method |
| pricing | ride_id |
| payments | ride_id, status, method, timestamp, transaction_id |
| revenue | ride_id, settlement_status, created_at |
| notifications | user_id, ride_id, status, type, sent_timestamp |

## Troubleshooting

### Permission Denied on COPY
```sql
-- Use \COPY instead of COPY (runs as client, not server)
\COPY ride_platform.staging_auth FROM '/path/to/file.csv' ...
```

### Foreign Key Violations
```sql
-- Temporarily disable FK checks
SET session_replication_role = 'replica';
-- Run imports
-- Re-enable
SET session_replication_role = 'origin';
```

### Out of Memory
```sql
-- Increase work_mem for large imports
SET work_mem = '256MB';
```

## Notes

- The `ride_platform` schema is separate from the Prisma-managed `public` schema
- This data is for analytics/reporting and does not affect the main application
- Revenue table only contains records for completed payments (20% commission rate)
