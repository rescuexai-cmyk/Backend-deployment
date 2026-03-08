#!/bin/bash
# Run Prisma migrations against the database
# Usage: ./scripts/run-migrations.sh [--docker]
#   --docker: Run migrations from inside driver-service container (use when DB is not exposed)
# Requires: .env with POSTGRES_PASSWORD (or DATABASE_URL)

set -e
cd "$(dirname "$0")/.."

USE_DOCKER=false
[ "$1" = "--docker" ] && USE_DOCKER=true

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

if [ "$USE_DOCKER" = true ]; then
  echo "Running migrations via Docker (driver-service container)..."
  docker exec -e DATABASE_URL="postgresql://raahi:${POSTGRES_PASSWORD:-raahi_prod_2024_secure}@postgres:5432/raahi" \
    raahi-driver-service npx prisma migrate deploy
else
  if [ -z "$DATABASE_URL" ]; then
    export DATABASE_URL="postgresql://raahi:${POSTGRES_PASSWORD:-raahi_prod_2024_secure}@localhost:5432/raahi"
  fi
  echo "Running Prisma migrations..."
  npx prisma migrate deploy
fi

echo "✅ Migrations complete"
