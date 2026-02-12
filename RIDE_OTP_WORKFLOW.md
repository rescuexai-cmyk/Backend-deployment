# Ride Booking to OTP Verification – Full Workflow

This document describes the end-to-end flow from when a user books a ride to when the driver verifies the passenger’s OTP to start the ride. Each step is implemented in the backend.

---

## Overview

| Step | Who | What happens |
|------|-----|--------------|
| 1 | Passenger | Books ride → backend creates ride, generates 4-digit OTP, returns ride + OTP to passenger |
| 2 | Backend | Finds nearby drivers, broadcasts ride to drivers via Socket.io |
| 3 | Driver | Receives ride offer (socket + optional GET /rides/available), accepts via API |
| 4 | Backend | Assigns driver to ride, broadcasts “driver assigned” to passenger |
| 5 | Driver | Marks “arrived” → passenger shows OTP; driver enters OTP and starts ride |
| 6 | Backend | Verifies OTP, updates status to RIDE_STARTED |

---

## Step-by-step flow

### Step 1: Passenger books ride

- **Endpoint:** `POST /api/rides`
- **Auth:** Bearer (passenger)
- **Body:** `pickupLat`, `pickupLng`, `dropLat`, `dropLng`, `pickupAddress`, `dropAddress`, `paymentMethod`, etc.

**Backend:**

1. Calculates fare (pricing service).
2. Generates 4-digit OTP: `generateRideOtp()` → 1000–9999.
3. Creates ride in DB with `rideOtp` stored.
4. Fetches nearby drivers (pricing service).
5. Calls realtime service: `POST /internal/broadcast-ride-request` with `rideId`, `rideData`, `driverIds`.
6. Returns ride to passenger with **`rideOtp`** included (only for passenger).

**Result:** Passenger gets ride object including `rideOtp` (e.g. `"4521"`). They must show this to the driver when the driver arrives.

---

### Step 2: Driver receives the ride

**Option A – Real-time (primary)**

- Driver app is connected to **Socket.io** and has joined as driver:
  - Emit `join-driver` or `driver-online` with `userId` (or `driverId`).
  - Backend resolves `userId` → `driverId`, adds socket to rooms `driver-{driverId}` and `available-drivers`.
- When ride is created, backend:
  - Sends to each nearby driver’s room: `driver-{driverId}`.
  - Also sends to room `available-drivers`.
- Event name: **`new-ride-request`**.
- Payload (no OTP): `rideId`, `pickupLocation`, `dropLocation`, `estimatedFare`, `passengerName`, etc.

**Option B – Polling (fallback)**

- **Endpoint:** `GET /api/rides/available?lat=...&lng=...&radius=...`
- **Auth:** Bearer (driver)
- Returns list of PENDING rides near the driver. Response does **not** include OTP (driver gets OTP from passenger later). It includes `otp_required_at_start: true` so the app can show “Ask passenger for 4-digit code when you start”.

**Result:** Driver sees the new ride (on socket and/or on available list) and can accept it.

---

### Step 3: Driver accepts ride

- **Endpoint:** `POST /api/rides/:id/accept`
- **Auth:** Bearer (driver)
- **Body:** None

**Backend:**

1. Resolves user to driver (DB).
2. Checks driver is verified, active, and (optionally) online.
3. Loads ride; ensures `status === 'PENDING'` and `driverId == null`.
4. In a transaction: updates ride to `driverId = driver.id`, `status = 'DRIVER_ASSIGNED'`.
5. Broadcasts “driver assigned” to passenger (realtime).
6. Returns updated ride (no OTP for driver).

**Result:** Ride is assigned to this driver; passenger is notified.

---

### Step 4: Status updates before start

- Driver (and optionally passenger) can update status via:
  - **Endpoint:** `PUT /api/rides/:id/status`
  - **Body:** `{ "status": "CONFIRMED" }` then `{ "status": "DRIVER_ARRIVED" }`

**Allowed transitions:**

- `PENDING` → `DRIVER_ASSIGNED` (done in accept).
- `DRIVER_ASSIGNED` → `CONFIRMED`.
- `CONFIRMED` → `DRIVER_ARRIVED`.
- `DRIVER_ARRIVED` → `RIDE_STARTED` (only after OTP verification, see Step 5).
- `RIDE_STARTED` → `RIDE_COMPLETED`.

**Result:** When driver reaches pickup, they set status to `DRIVER_ARRIVED`. Passenger then shows the 4-digit OTP from the app; driver will enter it in the next step.

---

### Step 5: Driver verifies OTP and starts ride

- **Endpoint:** `POST /api/rides/:id/start`
- **Auth:** Bearer (driver)
- **Body:** `{ "otp": "4521" }` (4 digits, from passenger)

**Backend:**

1. Ensures requester is the assigned driver.
2. Ensures ride status is **`DRIVER_ARRIVED`**.
3. Loads `ride.rideOtp` from DB.
4. Compares `ride.rideOtp === body.otp`.
5. If match: calls `updateRideStatus(rideId, 'RIDE_STARTED', userId)` and returns updated ride.
6. If no match: responds `400` with `code: 'INVALID_OTP'`.

**Alternative:** `PUT /api/rides/:id/status` with `{ "status": "RIDE_STARTED", "otp": "4521" }` uses the same OTP check and then updates status.

**Result:** Ride moves to `RIDE_STARTED` only when the driver enters the correct OTP that the passenger was given at booking.

---

### Step 6: Complete ride

- **Endpoint:** `PUT /api/rides/:id/status`
- **Body:** `{ "status": "RIDE_COMPLETED" }`
- Backend sets `completedAt`, `paymentStatus = 'PAID'`, etc.

---

## Summary: Does the workflow work?

| Requirement | Implemented |
|------------|-------------|
| Passenger gets 4-digit OTP when booking | Yes – `createRide` generates OTP, stores it, returns it only to passenger in response and in GET ride when requester is passenger. |
| Driver receives the ride (real-time) | Yes – realtime service broadcasts `new-ride-request` to driver rooms and `available-drivers`. |
| Driver can accept the ride | Yes – `POST /api/rides/:id/accept` assigns driver and sets status to `DRIVER_ASSIGNED`. |
| Driver does not get OTP from API | Yes – OTP is only in responses for the passenger. Available rides for driver no longer return a random OTP; they use `otp_required_at_start: true`. |
| Driver must enter OTP to start | Yes – `POST /api/rides/:id/start` and `PUT .../status` with `RIDE_STARTED` require correct `otp` and only allow from `DRIVER_ARRIVED`. |
| OTP is verified against DB | Yes – Comparison is `ride.rideOtp === providedOtp` from DB. |

---

## Bug fix applied

- **Before:** `GET /api/rides/available` (for drivers) returned a **random** OTP (`Math.floor(1000 + Math.random() * 9000)`). That code would never match the stored `rideOtp`, so “Start ride” would always fail if the driver used that value.
- **After:** Available rides no longer return any OTP. They return `otp_required_at_start: true` so the app can show “Ask passenger for 4-digit code when you start the ride.” The driver gets the real OTP from the passenger in person and enters it in `POST /api/rides/:id/start`.

---

## App-side checklist

1. **Passenger app:** After booking, show the 4-digit OTP clearly and keep it visible until the ride has started (e.g. on the “Waiting for driver” / “Driver arrived” screen).
2. **Driver app:**  
   - Listen for `new-ride-request` on Socket.io and/or use `GET /api/rides/available`.  
   - On “Start ride”, show an input for the 4-digit code and call `POST /api/rides/:id/start` with `{ "otp": "<user entered>" }`.  
   - Handle `INVALID_OTP` (e.g. “Wrong code, please check with passenger”).
3. **Driver app:** Ensure socket registration uses the same identity as the one used for `POST /api/rides/:id/accept` (backend resolves `userId` → `driverId` for socket rooms).

With the above, the backend flow from booking to OTP verification is implemented and consistent: user gets the OTP when they book, driver gets the ride and accepts it, and the driver verifies the OTP when starting the ride.
