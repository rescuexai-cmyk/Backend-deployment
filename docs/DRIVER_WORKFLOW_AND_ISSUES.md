# Driver-Side Workflow – Start Riding, Stop Ride, Accept, OTP, Confirm Pickup, Complete Ride

This document describes the **full driver-side workflow** from start riding through complete ride, and **enlists issues** found. No code or files were changed; documentation only.

---

## 1. Workflow Overview (Order of Operations)

| Step | Action | Endpoint / Channel | Result |
|------|--------|--------------------|--------|
| 1 | **Start riding** (go online) | PATCH `/api/driver/status` + Socket `join-driver` / `driver-online` | Driver is online and can receive ride requests |
| 2 | **Receive ride request** | Socket event `new-ride-request` | Driver sees ride in app (from broadcast) |
| 3 | **Accept ride** | POST `/api/rides/:id/accept` | Ride status: PENDING → DRIVER_ASSIGNED |
| 4 | **Confirm** (optional) | PUT `/api/rides/:id/status` body `{ "status": "CONFIRMED" }` | DRIVER_ASSIGNED → CONFIRMED |
| 5 | **Confirm pickup** (driver arrived) | PUT `/api/rides/:id/status` body `{ "status": "DRIVER_ARRIVED" }` | CONFIRMED → DRIVER_ARRIVED |
| 6 | **OTP verification & start ride** | POST `/api/rides/:id/start` body `{ "otp": "1234" }` | DRIVER_ARRIVED → RIDE_STARTED |
| 7 | **Complete ride** | PUT `/api/rides/:id/status` body `{ "status": "RIDE_COMPLETED" }` | RIDE_STARTED → RIDE_COMPLETED |
| 8 | **Stop riding** (go offline) | PATCH `/api/driver/status` body `{ "online": false }` | Driver offline; penalty created (₹10) |

Status flow: **PENDING** → **DRIVER_ASSIGNED** (accept) → **CONFIRMED** → **DRIVER_ARRIVED** (confirm pickup) → **RIDE_STARTED** (OTP) → **RIDE_COMPLETED**.

---

## 2. Step-by-Step Workflow Detail

### 2.1 Start riding (go online)

**API:** PATCH `/api/driver/status`  
**Body:** `{ "online": true, "location": { "latitude": 28.61, "longitude": 77.20 } }` (location optional)  
**Auth:** Driver Bearer (authenticateDriver).

**Flow:**
1. Driver-service looks up driver by `req.user.id` (userId).
2. If driver tries to go online: checks for **unpaid penalties** (DriverPenalty, status PENDING). If any → **403** `PENALTY_UNPAID`, `penaltyDue`, driver cannot go online until paid.
3. If driver goes **offline** (was online, now online: false): creates a **Stop Riding penalty** (default ₹10, `PENALTY_STOP_RIDING_AMOUNT`).
4. Updates driver: `isOnline`, `lastActiveAt`, `currentLatitude`, `currentLongitude`.
5. Returns 200 with `online`, `last_seen`, `location`, `status_verified`.

**Realtime (must do after or with PATCH):**
- Socket emit **`join-driver`** with driverId or userId (realtime resolves userId → driverId).
- Socket emit **`driver-online`** with same id.
- Realtime: `registerDriver()` joins socket to room `driver-{driverId}` and to `available-drivers`. Without this, the driver will **not** receive `new-ride-request` when a ride is created (broadcast targets `driver-{driverId}` and `available-drivers`).

**Issue (documented below):** If driver only joins socket but never calls PATCH, they appear in broadcast rooms but `assignDriver` will reject with "Driver is not online" because DB still has `isOnline: false`.

---

### 2.2 Receive ride request (real-time)

**Channel:** Socket.io – listen for **`new-ride-request`**.

**Flow:**
1. Passenger creates ride → ride-service creates ride, gets **nearby drivers** via pricing-service `GET /api/pricing/nearby-drivers` (by pickup lat/lng, radius 10 km).
2. Ride-service calls realtime-service **POST /internal/broadcast-ride-request** with `rideId`, `rideData`, `driverIds`.
3. Realtime: for each driverId, emits **`new-ride-request`** to room `driver-{driverId}`; also emits to room **`available-drivers`** as fallback.
4. Driver app (which joined `driver-{driverId}` and/or `available-drivers`) receives the event and can show the ride for accept.

**Note:** Nearby drivers are those returned by pricing (online, in area). They must be **connected to socket** and in the correct room; otherwise broadcast may miss them (realtime logs P0 warning if no one received).

---

### 2.3 Accept ride

**API:** POST `/api/rides/:id/accept`  
**Auth:** Bearer (authenticate – any user, but handler checks driver profile).

**Flow:**
1. Resolve **driver** by `req.user.id`: `prisma.driver.findUnique({ where: { userId } })`. No driver profile → **403** "Driver access required".
2. Checks: driver **isVerified**, **isActive**. If not → 403. If driver **isOnline** is false → only **log warning**, still allow (actual assignment will fail in service if DB says not online).
3. Load ride: must exist, **status PENDING**, **driverId null**. Else 404 or 409 (already taken / invalid status).
4. **rideService.assignDriver(rideId, driver.id)**:
   - Inside **transaction** (Serializable): ride must still be `status: PENDING`, `driverId: null`; driver must exist, **isOnline**, **isActive**. If not → throws.
   - Updates ride: `driverId`, `status: 'DRIVER_ASSIGNED'`.
   - Broadcasts **driver-assigned** to ride room (passenger notified).
5. Returns 200 with formatted ride.

**Race:** Two drivers can hit accept; one wins (optimistic lock on ride), the other gets 409 "Ride already accepted".

---

### 2.4 Confirm (optional) – DRIVER_ASSIGNED → CONFIRMED

**API:** PUT `/api/rides/:id/status`  
**Body:** `{ "status": "CONFIRMED" }`  
**Auth:** Bearer (authenticate). **No check that caller is the driver.**

**Flow:** rideService.updateRideStatus validates transition DRIVER_ASSIGNED → CONFIRMED and updates ride status. No driver-only check.

---

### 2.5 Confirm pickup (driver arrived)

**API:** PUT `/api/rides/:id/status`  
**Body:** `{ "status": "DRIVER_ARRIVED" }`  
**Auth:** Bearer. **No check that caller is the driver.**

**Flow:** updateRideStatus validates CONFIRMED → DRIVER_ARRIVED, updates ride. Realtime can also emit **`driver-arrived`** (socket event) for passenger UI; the **source of truth** for status is this PUT.

---

### 2.6 OTP verification and start ride

**API:** POST `/api/rides/:id/start`  
**Body:** `{ "otp": "1234" }` (4-digit string)  
**Auth:** Bearer.

**Flow:**
1. Resolve driver by `req.user.id`. No driver → 403.
2. Load ride (id, status, driverId, rideOtp). No ride → 404. Caller must be **assigned driver** (ride.driverId === driver.id) → else 403.
3. Ride must be in status **DRIVER_ARRIVED** → else 400 "Driver must arrive first".
4. **OTP check:** `ride.rideOtp === providedOtp`. If not → 400 "Invalid OTP. Please ask the passenger for the correct code."
5. **Logging:** Code logs `Expected ${ride.rideOtp}, got ${providedOtp}` – **OTP appears in server logs** (security issue).
6. rideService.updateRideStatus(rideId, 'RIDE_STARTED', userId). Sets `startedAt`. Broadcasts status update.

**Alternative:** PUT `/api/rides/:id/status` with `{ "status": "RIDE_STARTED", "otp": "1234" }` – same OTP check and transition.

---

### 2.7 Complete ride

**API:** PUT `/api/rides/:id/status`  
**Body:** `{ "status": "RIDE_COMPLETED" }`  
**Auth:** Bearer. **No check that caller is the driver.**

**Flow:**
1. updateRideStatus: RIDE_STARTED → RIDE_COMPLETED. Sets `completedAt`, `paymentStatus: 'PAID'`.
2. **Driver earnings:** In same flow, creates DriverEarning (ride total, 20% commission, net), increments driver `totalRides` and `totalEarnings`.
3. Broadcasts ride status update.

---

### 2.8 Stop riding (go offline)

**API:** PATCH `/api/driver/status`  
**Body:** `{ "online": false }`  
**Auth:** Driver Bearer.

**Flow:** If previous state was online, creates **DriverPenalty** (reason STOP_RIDING, amount e.g. ₹10, PENDING). Updates driver `isOnline: false`, `lastActiveAt`, location unchanged. Next time driver tries to go online, 403 until penalty is paid (GET `/api/driver/penalties`, POST `/api/driver/penalties/pay`).

---

## 3. Issues Enlisted

| # | Severity | Issue |
|---|----------|--------|
| **D1** | **High** | **PUT `/api/rides/:id/status` does not restrict who can change status.** Any authenticated user who knows the ride id can call PUT with `CONFIRMED`, `DRIVER_ARRIVED`, `RIDE_STARTED`, or `RIDE_COMPLETED`. So a **passenger** could set `DRIVER_ARRIVED` or `RIDE_COMPLETED` without the driver. Only transition rules (e.g. must have driver for RIDE_COMPLETED) are enforced; **caller role (driver vs passenger) is not**. Recommendation: enforce that only the **driver** can set DRIVER_ARRIVED, RIDE_STARTED, RIDE_COMPLETED (and only passenger for CONFIRMED if desired). |
| **D2** | **High** | **OTP logged in plain text.** In POST `/api/rides/:id/start`, console.log (and possibly logger) outputs `Expected ${ride.rideOtp}, got ${providedOtp}`. OTP then appears in server logs and is a **security risk** (anyone with log access can use it). OTP should never be logged. |
| **D3** | **Medium** | **Accept allows offline driver at route level.** Route checks `driver.isOnline` but only logs a warning and still proceeds. assignDriver then throws "Driver is not online" if DB has isOnline false. So the driver gets a **500** (or 403 if service maps it) instead of a clear **403 "Driver must be online to accept"** at the route. Recommendation: return 403 at route when !driver.isOnline so client gets a clear message. |
| **D4** | **Medium** | **Order dependency: PATCH status before socket.** If the driver only joins socket (`join-driver` / `driver-online`) but never calls PATCH `/api/driver/status` with `online: true`, they can receive `new-ride-request` but **accept will fail** (assignDriver requires isOnline). Docs/clients should state: call PATCH status first, then socket join. |
| **D5** | **Low** | **CONFIRMED step is optional and not enforced.** Flow allows DRIVER_ASSIGNED → CONFIRMED → DRIVER_ARRIVED. If the app skips CONFIRMED and goes straight to DRIVER_ARRIVED from DRIVER_ASSIGNED, that is **invalid** (allowed transitions are CONFIRMED or CANCELLED from DRIVER_ASSIGNED). So CONFIRMED is required in practice; document for clients. |
| **D6** | **Low** | **Driver cancel ride.** POST `/api/rides/:id/cancel` in the codebase is wired to cancelRide(..., 'passenger', ...). If drivers can cancel (e.g. after accept), a separate driver-cancel path or a parameter (cancelledBy: driver) with authorization should exist; otherwise driver cancel may be missing or reusing passenger cancel. |

---

## 4. Summary Table – Driver Workflow Endpoints

| Step | Method | Path | Auth | Notes |
|------|--------|------|------|--------|
| Start riding | PATCH | `/api/driver/status` | Driver | `online: true`; unpaid penalty blocks |
| Stop riding | PATCH | `/api/driver/status` | Driver | `online: false`; creates penalty |
| Receive ride | Socket | listen `new-ride-request` | - | After join-driver + driver-online |
| Accept ride | POST | `/api/rides/:id/accept` | User (driver) | Ride PENDING, driverId null; race-safe |
| Confirm | PUT | `/api/rides/:id/status` | Any* | `status: CONFIRMED` |
| Confirm pickup | PUT | `/api/rides/:id/status` | Any* | `status: DRIVER_ARRIVED` |
| Start ride (OTP) | POST | `/api/rides/:id/start` | User (driver) | Body `{ otp }`; ride must be DRIVER_ARRIVED |
| Complete ride | PUT | `/api/rides/:id/status` | Any* | `status: RIDE_COMPLETED` |

\* Any authenticated user; no driver-only check (see D1).

---

**Document version:** 1.0  
**Scope:** Driver workflow only; no code changes.
