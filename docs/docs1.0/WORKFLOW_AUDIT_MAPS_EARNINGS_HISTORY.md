# Workflow Audit: Map Suggestions, Ride History, Driver Earnings, Penalty, Platform Fee

**Audit type:** Read-only workflow description and issue list. No code changes.

---

## 1. Map suggestion while entering position (pickup/drop)

### What the backend does

- **No backend API for address/place suggestions or geocoding.** There is no endpoint that:
  - Takes a partial address or text and returns place suggestions (autocomplete).
  - Takes coordinates and returns an address (reverse geocoding).
  - Takes an address and returns coordinates (geocoding).

- **Ride creation** (`POST /api/rides`) expects the client to send:
  - `pickupLat`, `pickupLng`, `dropLat`, `dropLng` (coordinates)
  - `pickupAddress`, `dropAddress` (strings, for display)

So the backend **does not** drive “map suggestion while entering position”. It only accepts already-resolved coordinates and address strings.

### Intended flow (client-side)

1. User types or selects a place in the app (e.g. via Google Places Autocomplete or similar on the client).
2. Client gets coordinates and address from the maps/places SDK.
3. Client calls `POST /api/rides` with those coordinates and address strings.

### Issues

| # | Issue | Severity |
|---|--------|----------|
| 1 | **No backend support for map/address suggestions.** Any autocomplete or “suggest position” behaviour must be implemented entirely on the client (e.g. Google Places API, Mapbox) using the app’s own API keys. Backend does not expose geocode/place/autocomplete endpoints. | Medium (by design, but should be documented for frontend) |
| 2 | **GOOGLE_MAPS_API_KEY** appears in `.env` but is not used in any service code. If the app was intended to proxy map/geocode calls through the backend for key hiding, that is not implemented. | Low |

---

## 2. What the backend does with “maps” (coordinates, pricing, nearby)

### Endpoints and behaviour

- **Pricing (fare calculation)**  
  - **POST /api/pricing/calculate**  
  - Input: `pickupLat`, `pickupLng`, `dropLat`, `dropLng` (and optional `vehicleType`, `scheduledTime`).  
  - Uses **geolib** (no Google Maps) to compute distance; applies pricing rules and surge/peak logic.  
  - Returns fare breakdown and estimated duration.  
  - No map tiles, no geocoding, no place search.

- **Nearby drivers**  
  - **GET /api/pricing/nearby-drivers?lat=&lng=&radius=**  
  - Input: lat, lng, radius (km).  
  - Uses **geolib** `getBoundsOfDistance` and DB filters on driver `currentLatitude` / `currentLongitude` to return drivers in range.  
  - No map/geocode APIs.

- **Ride creation**  
  - **POST /api/rides**  
  - Persists `pickupLatitude`, `pickupLongitude`, `dropLatitude`, `dropLongitude`, `pickupAddress`, `dropAddress` and uses the same coordinates for pricing (via pricing service) and for broadcasting to drivers.

- **Surge areas**  
  - **GET /api/pricing/surge-areas**  
  - Returns active surge areas (center lat/lng, radius, multiplier) from DB.  
  - Used in pricing; no external map API.

### Issues

| # | Issue | Severity |
|---|--------|----------|
| 1 | No reverse geocoding: if the client sends only coordinates, the backend never fills `pickupAddress`/`dropAddress`; they must be sent by the client. | Low |
| 2 | Distance/duration in pricing is purely geometric (geolib) and a simple speed assumption (e.g. 25 km/h for duration). No routing or real-time traffic. | Low (acceptable for MVP) |

---

## 3. Ride history update (user and driver)

### User (passenger) side

- **GET /api/rides**  
  - Query params: `page`, `limit`.  
  - Returns rides where `passengerId = authenticated user`, ordered by `createdAt` desc, paginated.  
  - Each ride is formatted with `formatRide(ride, true)` (includes OTP for passenger).  
  - **No “update” endpoint:** history is “current state at read time”. When a ride’s status (or any field) changes (e.g. driver assigned, completed), the next **GET /api/rides** shows the new state. There is no dedicated “refresh history” or “history update” API; the list is just a read of current DB state.

### Driver side

- **GET /api/driver/trips**  
  - Query params: `page`, `limit`.  
  - Returns rides where `driverId = authenticated driver`, ordered by `createdAt` desc, paginated.  
  - Mapped to a trip list (passenger name/phone, addresses, distance, duration, fare, status, `created_at`).  
  - Same idea: no separate “history update” endpoint; “history” is whatever is in the DB at the time of the request.

### How “updates” appear

- Status changes (e.g. accept, start, complete) are done via **PUT /api/rides/:id/status** or **POST /api/rides/:id/accept**, **POST /api/rides/:id/start**, etc.  
- Realtime (Socket.io) can push status events (e.g. `ride-status-update`, `driver-assigned`) to the active ride screen.  
- The **list** of past/current rides (history) does not get pushed; the client must call **GET /api/rides** or **GET /api/driver/trips** again to see updated status in the list.

### Issues

| # | Issue | Severity |
|---|--------|----------|
| 1 | **No realtime push for ride list.** When a new ride is created or status changes, the “history” list on the other device does not update until the client refetches (GET /api/rides or GET /api/driver/trips). | Low |
| 2 | **Driver trips:** `rating` in the response is hardcoded as `4.5`, not derived from ride or driver rating. | Medium |

---

## 4. Driver earnings workflow

### When earnings are created

- On **ride completion**: when status is set to **RIDE_COMPLETED** (in **ride-service** `updateRideStatus`):
  - Commission: **20%** of `ride.totalFare` (platform fee).
  - `netAmount = totalFare - commission`.
  - A **DriverEarning** row is created: `driverId`, `rideId`, `amount` (= totalFare), `commission`, `netAmount`, `date` (default `now()`).
  - Driver’s **totalRides** is incremented by 1 and **totalEarnings** by `netAmount`.

### Where earnings are exposed

- **GET /api/driver/profile**  
  - Includes `earnings: { today, week, month, total }`.  
  - “Today” is computed from `driver.earnings` where `date >= start of today (00:00:00)` (only today’s earnings are loaded in profile).  
  - Week/month/total in profile use **approximations**: `week: totalEarnings * 0.3`, `month: totalEarnings * 0.7`, `total: totalEarnings`. So profile’s week/month are not true “last 7 days” / “current month” from earning records.

- **GET /api/driver/earnings**  
  - Loads all `driver.earnings` (ordered by date desc).  
  - **Today:** filter `e.date >= today` (today = start of calendar day 00:00:00).  
  - **Week:** filter `e.date >= weekStart` (weekStart = today - 7 days). So “week” = last 7 calendar days.  
  - **Month:** filter `e.date >= monthStart` where `monthStart = new Date(today); monthStart.setMonth(today.getMonth() - 1)`. So “month” is “from ~30 days ago to now”, not “current calendar month”.  
  - Returns: `today`, `week`, `month`, `total` (amount, trips, hours_online, average_per_trip) and `breakdown`.

### Issues

| # | Issue | Severity |
|---|--------|----------|
| 1 | **Profile earnings:** Week and month are not from real earning records; they use fixed fractions of `totalEarnings` (0.3 and 0.7). So “week” and “month” in profile are placeholders, not actual last 7 days or current month. | Medium |
| 2 | **GET /api/driver/earnings** – `hours_online` is **hardcoded** (e.g. 6.5, 42, 168, 420) and not derived from driver activity. | Medium |
| 3 | **GET /api/driver/earnings** – `breakdown` (base_fare, distance_fare, time_fare, surge_bonus) is **estimated from total**: e.g. 10%, 70%, 15%, 5% of `driver.totalEarnings`, not from actual ride-level fare components. So it’s not a true breakdown. | Medium |
| 4 | **“Today”** is calendar day (00:00 to now), not “last 24 hours”. If product expects “last 24 hours”, current behaviour is wrong. | Low |
| 5 | **Month window:** `setMonth(getMonth()-1)` can be wrong around year boundary (e.g. Jan 10 → Dec 10 previous year). For “last 30 days” the intent is clearer with an explicit “now - 30 days” date. | Low |

---

## 5. Platform fee (driver)

### How it’s applied

- **Only at ride completion** in **ride-service** `updateRideStatus` when `status === 'RIDE_COMPLETED'`:
  - `commissionRate = 0.20` (20%).
  - `commission = ride.totalFare * 0.20`.
  - `netAmount = ride.totalFare - commission`.
  - One **DriverEarning** row per completed ride with `amount`, `commission`, `netAmount`, `date`.

- **Display:**  
  - Driver sees “earning” as **netAmount** (80% of fare) in available-rides and in earnings.  
  - GET /api/driver/earnings does not explicitly return “platform fee” or “commission” in the summary; it’s implicit (total fare − net = commission). Individual **DriverEarning** records in DB have `commission` and `netAmount`.

### 24-hour / timeline

- **No separate “24-hour” or “platform fee summary” endpoint.**  
- “Today” in earnings = calendar day (midnight to now), not rolling 24 hours.  
- There is no endpoint that returns “platform fee collected in last 24 hours” or “platform fee timeline”; commission is only stored per ride in **DriverEarning**.

### Issues

| # | Issue | Severity |
|---|--------|----------|
| 1 | **Platform fee is fixed at 20%** (hardcoded). No config (env/DB) or per-ride/per-region rules. | Low |
| 2 | **No explicit “platform fee” or “commission” in GET /api/driver/earnings response** for the aggregated periods; client would need to infer from (total fare − net) or from individual earning records if exposed. | Low |
| 3 | **No 24-hour window:** “Today” is calendar day, not last 24 hours. | Low |

---

## 6. Penalty endpoints workflow

### What exists

- **No penalty-related endpoints or logic** in the codebase:
  - No “penalty” or “deduction” in schema (e.g. no Penalty table, no penalty field on DriverEarning or Ride).
  - No routes or handlers for applying penalties, listing penalties, or reversing them.

So there is **no backend workflow for penalties** at all.

### Issues

| # | Issue | Severity |
|---|--------|----------|
| 1 | **Penalty workflow is missing.** If product requires driver penalties (e.g. cancellation, no-show), nothing is implemented: no model, no APIs, no application to earnings. | High (if product needs it) |

---

## 7. Summary table

| Area | Backend behaviour | Issues |
|------|-------------------|--------|
| **Map suggestion / position entry** | No geocode/place/autocomplete APIs. Client must send coordinates + address strings. | No backend map suggestions; GOOGLE_MAPS_API_KEY unused. |
| **Maps (coordinates, pricing)** | Pricing and nearby-drivers use geolib and DB only. No external map APIs. | No reverse geocode; distance/duration is geometric only. |
| **Ride history (user)** | GET /api/rides returns current state of user’s rides; no push, no “history update” API. | List doesn’t auto-update; refetch required. |
| **Ride history (driver)** | GET /api/driver/trips returns driver’s rides; same “read current state” model. | Trip rating hardcoded 4.5. |
| **Driver earnings** | Created on RIDE_COMPLETED (20% commission). GET /api/driver/earnings and profile expose today/week/month/total. | Profile week/month are fake (0.3/0.7 of total); hours_online and breakdown are hardcoded/estimated. |
| **Platform fee** | 20% at completion; stored per ride in DriverEarning. | Fixed 20%; no “last 24h” or platform-fee timeline API. |
| **24-hour timeline** | “Today” = calendar day (00:00–now), not rolling 24 hours. | No rolling 24h window. |
| **Penalty** | No penalty model or endpoints. | Full feature missing. |

---

**End of audit.** No code was modified; this document only describes workflows and lists issues.
