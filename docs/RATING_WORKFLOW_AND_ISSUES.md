# Rating Workflow (User Rates After Ride Completion) – Check & Issues

This document describes the **workflow** of the rating a user (passenger) gives after a ride is completed, and **enlists issues** found. No code or files were changed; documentation only.

---

## 1. Endpoint

| Endpoint | Method | Service | Purpose |
|----------|--------|---------|---------|
| `/api/rides/:id/rating` | POST | ride-service | Submit rating (and optional feedback) for a completed ride |

**Gateway:** `/api/rides/*` → ride-service (5004).

---

## 2. Workflow (Step-by-Step)

### 2.1 Request

- **Auth:** Required. `Authorization: Bearer <accessToken>`.
- **Body:**  
  - `rating` (required): number, 1 ≤ rating ≤ 5 (validated as float min 1, max 5).  
  - `feedback` (optional): string.

### 2.2 Route handler (ride routes)

1. **Validation:** express-validator checks `rating` (float 1–5) and optional `feedback` (string). If invalid → **400** "Validation failed" + errors.
2. **Ride lookup:** `rideService.getRideById(rideId)`. If not found → **404** "Ride not found".
3. **Authorization:** Caller must be either the **passenger** or the **driver** of the ride (`ride.passengerId === req.user.id` OR `ride.driverId === req.user.id`). Otherwise → **403** "Access denied".
4. **Status check:** Ride must be in status **RIDE_COMPLETED**. Otherwise → **400** "Can only rate completed rides".
5. **Submit:** `rideService.submitRideRating(rideId, rating, feedback, userId)`.
6. **Response:** **200** `{ success: true, message: 'Rating submitted successfully', data: updated }` where `data` is the formatted ride (with driver included).

### 2.3 submitRideRating (rideService)

1. **Lookup ride:** `prisma.ride.findUnique({ where: { id: rideId } })`. If not found, throws (→ 500).
2. **No ride update:** `prisma.ride.update({ where: { id: rideId }, data: {} })` – **empty `data`**, so the Ride row is not updated with rating or feedback. (Ride model has no `rating` or `feedback` column.)
3. **Driver rating (passenger only):**  
   If `ride.driverId` exists **and** `ride.passengerId === userId` (rater is the passenger):
   - Load driver: `prisma.driver.findUnique({ where: { id: ride.driverId } })`.
   - Compute new average:  
     `newAvg = ((driver.rating * driver.totalRides) + rating) / (driver.totalRides + 1)`.
   - Update driver: `prisma.driver.update({ where: { id: ride.driverId }, data: { rating: Math.round(newAvg * 10) / 10 } })`.
4. **Return:** `formatRide(updatedRide)` (the ride object fetched in step 2, with driver include – driver’s rating in this object is still the **old** value because the driver was updated after this fetch).

**If the caller is the driver** (rating the passenger): the route allows it (403 only if neither passenger nor driver), but inside `submitRideRating` only the branch `ride.passengerId === userId` updates anything. So a driver-submitted rating is accepted and returns success but **has no effect** (no passenger rating model or storage).

---

## 3. Data Model (Relevant Parts)

- **Ride:** No `rating` or `feedback` (or `ratedAt`) field. Per-ride rating/feedback is not stored.
- **Driver:** Has `rating` (Float, default 0.0) and `totalRides` (Int). `totalRides` is incremented when a ride reaches **RIDE_COMPLETED** (in `updateRideStatus`), not when a rating is submitted.
- **User (passenger):** No aggregate rating or per-ride rating stored; driver cannot affect passenger rating in backend.

---

## 4. Issues Enlisted

| # | Severity | Issue |
|---|----------|--------|
| **R1** | **High** | **Wrong average formula.** Driver’s new rating is computed as `(driver.rating * driver.totalRides + rating) / (driver.totalRides + 1)`. `totalRides` is the count of **completed rides**, not “rides that have been rated”. So when many completed rides have not been rated yet, the denominator is too large and the average is incorrect (e.g. one rating gets diluted as if it were one of totalRides+1 ratings). Fix options: (a) store a separate “rating count” and use it in the average, or (b) store per-ride ratings and compute average from them. |
| **R2** | **High** | **No idempotency / repeat rating.** The same passenger can call POST `/api/rides/:id/rating` multiple times for the same ride. Each call recomputes and updates the driver’s average using the same ride again, so one ride can be counted multiple times and the driver’s rating is distorted. There is no “already rated” check or stored per-ride rating to prevent this. |
| **R3** | **Medium** | **Feedback is ignored.** The API accepts optional `feedback` and passes it to `submitRideRating`, but the service uses `_feedback` and never stores it. The Ride model has no feedback/comment field, so user feedback is discarded. |
| **R4** | **Medium** | **Driver can “rate” but it has no effect.** The route allows both passenger and driver to call POST rating (same 403 rule: must be passenger or driver). Only the passenger branch updates the driver’s rating. If the driver submits a rating (e.g. intended to rate the passenger), the API returns 200 and “Rating submitted successfully” but no data is stored and no passenger rating exists. This is confusing and should be either documented or restricted (e.g. only passenger may rate for this ride). |
| **R5** | **Low** | **Response shows stale driver rating.** After updating the driver’s rating, the handler returns `formatRide(updatedRide)`. `updatedRide` was loaded before the driver update, so the returned ride’s driver object still has the **previous** `rating`. The client may show the old rating until they refetch the ride/driver. |
| **R6** | **Low** | **No per-ride rating stored.** Only the driver’s aggregate `rating` is updated. There is no record of “ride X was rated 4 by passenger” for analytics, dispute, or display of “your rating for this ride”. |

---

## 5. Summary

| Aspect | Status |
|--------|--------|
| Endpoint exists | Yes – POST `/api/rides/:id/rating` |
| Auth & ride ownership | Yes – only passenger or driver, ride must exist |
| Only completed rides | Yes – status must be RIDE_COMPLETED |
| Rating validation | Yes – 1–5 float |
| Driver aggregate updated (passenger rates) | Yes – but formula uses totalRides (completed) not rating count → **wrong** (R1) |
| Idempotency / prevent repeat rating | No → **issue** (R2) |
| Feedback stored | No → **issue** (R3) |
| Driver rating passenger | Allowed by route but has no effect → **issue** (R4) |
| Response driver rating | Stale in response → **issue** (R5) |
| Per-ride rating record | None → **issue** (R6) |

---

**Document version:** 1.0  
**Scope:** Rating workflow only; no code changes.
