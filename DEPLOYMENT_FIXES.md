# Deployment Fixes

This document covers fixes for common production issues identified from logs.

---

## 1. Database: Missing `driverAssignedAt` and `driverArrivedAt` columns

**Error:** `The column rides.driverAssignedAt does not exist in the current database`

**Cause:** Prisma schema was updated but migrations were not applied to the production database.

**Fix:** Run migrations on the server:

```bash
cd /opt/raahi-backend   # or your deployment path

# Option A: Run via Node (if Node is installed)
source .env
npx prisma migrate deploy

# Option B: Run via Docker (if DB is in Docker)
docker exec -it raahi-postgres psql -U raahi -d raahi -c "
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS \"driverAssignedAt\" TIMESTAMP(3);
  ALTER TABLE rides ADD COLUMN IF NOT EXISTS \"driverArrivedAt\" TIMESTAMP(3);
"

# Option C: Use the migration script
chmod +x scripts/run-migrations.sh
./scripts/run-migrations.sh
```

After applying, restart the driver-service:
```bash
docker restart raahi-driver-service
```

---

## 2. JWT: Invalid signature

**Error:** `Invalid JWT token {"error":"invalid signature"}`

**Cause:** The `JWT_SECRET` used by auth-service (to sign tokens) does not match the one used by realtime-service, driver-service, etc. (to verify tokens).

**Fix:**

1. **Verify JWT_SECRET is set** in `.env`:
   ```bash
   grep JWT_SECRET /opt/raahi-backend/.env
   ```
   It must be a non-empty string (min 32 chars recommended).

2. **Ensure all services use the same secret** – `docker-compose.prod.yml` passes `JWT_SECRET: ${JWT_SECRET}` to all services. If `.env` has it, they all get it.

3. **Never regenerate JWT_SECRET** after users have logged in – that invalidates all existing tokens. If you must rotate:
   - Set new `JWT_SECRET` in `.env`
   - Restart all services
   - **All users must log out and log in again** to get new tokens

4. **Restart all services** after any `.env` change:
   ```bash
   docker compose -f docker-compose.prod.yml down
   docker compose -f docker-compose.prod.yml up -d
   ```

---

## 3. No drivers connected to realtime (0 Socket.io connections)

**Logs:** `Total unique connected drivers (Socket.io): 0`, `available-drivers room is EMPTY`

**Cause:** Usually a consequence of:
- **JWT invalid signature** – drivers' connections are rejected before they can join rooms
- **Connection failed** – Flutter app cannot reach realtime service (network/firewall)

**Fix:** Resolve the JWT issue first (see #2). Then verify:
- Realtime service is reachable: `curl http://YOUR_SERVER/realtime/health`
- Drivers can "Start Ride" without "Connection Failed" in the app

---

## 4. Driver blocked from going online

**Log:** `Blocked go-online: driver X has 1 unpaid penalty(ies), ₹10 due`

**Cause:** Driver has an unpaid penalty (e.g. from "Stop Riding" violation).

**Fix:** Driver must pay the penalty in the app, or for testing you can mark it paid in the database:

```sql
UPDATE driver_penalties 
SET status = 'PAID', "paidAt" = NOW() 
WHERE "driverId" = 'cmm0tiyip0001ytasr36rlc1u' AND status = 'PENDING';
```

---

## Quick checklist after deployment

- [ ] Run `npx prisma migrate deploy` (or apply migration SQL manually)
- [ ] Verify `JWT_SECRET` is set in `.env` and is consistent
- [ ] Restart all services after `.env` changes
- [ ] Test health: `curl http://YOUR_SERVER/health`
- [ ] Test realtime: `curl http://YOUR_SERVER/realtime/health`
