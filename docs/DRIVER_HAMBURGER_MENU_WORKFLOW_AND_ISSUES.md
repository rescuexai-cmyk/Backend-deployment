# Driver Hamburger Menu – Complete Workflow & Issues

This document describes the **complete workflow** of the driver hamburger menu and its components: **Home**, **Ride history**, **Earnings**, **Settings**, and **Help and support**. Sub-components and backend support are checked; **issues are enlisted** only. No code or files were changed.

---

## 1. Menu Overview and Backend Mapping

| Menu item        | Typical screen content                    | Primary backend endpoint(s) |
|------------------|-------------------------------------------|-----------------------------|
| **Home**         | Dashboard, profile summary, online status | GET `/api/driver/profile`, PATCH `/api/driver/status` |
| **Ride history** | List of trips, trip detail                | GET `/api/driver/trips`, GET `/api/rides/:id` |
| **Earnings**     | Today/week/month/total, breakdown, list   | GET `/api/driver/earnings`, GET `/api/driver/profile` (earnings slice) |
| **Settings**     | Profile edit, preferences, penalties, onboarding | GET `/api/driver/profile`, GET `/api/driver/onboarding/status`, GET `/api/driver/penalties`, POST `/api/driver/penalties/pay`, onboarding APIs |
| **Help and support** | Submit ticket, view requests          | POST `/api/driver/support` |

---

## 2. Home

**Purpose:** Driver dashboard / home: identity, online status, quick stats, maybe today’s earnings.

### 2.1 Workflow

- **GET `/api/driver/profile`** (Driver Bearer)
  - Returns: `driver_id`, `email`, `name`, `phone`, `license_number`, `vehicle_info`, `documents` (license/insurance/RC verified flags), `onboarding` (status, is_verified, can_start_rides, verification_notes), `status` (active/inactive), `rating`, `total_trips`, `earnings` (today, week, month, total), `is_online`, `current_location`.
  - **Profile earnings:** `today` = sum of today’s DriverEarning records (from DB). `week` = `Math.round(totalEarnings * 0.3)`, `month` = `Math.round(totalEarnings * 0.7)`, `total` = `driver.totalEarnings`. So **week and month on Home are not from real time windows**; they are fixed fractions of total.
- **PATCH `/api/driver/status`** (go online/offline, optional location) – see driver workflow doc. Blocked if unpaid penalty; going offline creates Stop Riding penalty.

### 2.2 Components inside Home

- **Header / identity:** Name, phone, photo → from profile (user + driver).
- **Online toggle:** Uses PATCH `/api/driver/status`; can show penalty message if 403 PENALTY_UNPAID.
- **Today’s earnings / quick stats:** From profile `earnings.today` (real) and `earnings.week` / `earnings.month` (fake fractions).
- **Verification / can_start_rides:** From profile `onboarding.can_start_rides`, `documents.all_verified`.

### 2.3 Issues (Home)

| #  | Severity | Issue |
|----|----------|--------|
| H1 | Medium   | **Profile `earnings.week` and `earnings.month` are not real.** They are `0.3` and `0.7` of `totalEarnings`, not “last 7 days” or “current month”. Home dashboard shows misleading week/month figures. |
| H2 | Low      | **Default location.** If driver has no lat/lng, profile returns `latitude: 28.6139, longitude: 77.209` (hardcoded default). Can be confusing if driver never shared location. |

---

## 3. Ride history

**Purpose:** List of driver’s past/current trips, with optional trip detail.

### 3.1 Workflow

- **GET `/api/driver/trips`** (Driver Bearer)  
  - Query: `page`, `limit` (default 1, 10).  
  - Returns rides where `driverId = current driver`, ordered by `createdAt` desc, paginated.  
  - Each item: `trip_id`, `passenger_name`, `passenger_phone`, `pickup_address`, `drop_address`, `distance`, `duration`, `fare`, `status` (lowercased), `rating`, `created_at`.  
  - **Rating:** Always **4.5** in response; not derived from ride or driver rating.
- **Trip detail:** Driver can use **GET `/api/rides/:id`** (ride-service) with same Bearer; auth allows driver to see their ride. No driver-specific “trip detail” endpoint; ride detail is shared.

### 3.2 Components inside Ride history

- **List:** From GET `/api/driver/trips` (paginated). No realtime push; list updates only on refetch.
- **Trip card:** trip_id, passenger, addresses, fare, status, **rating (hardcoded 4.5)**, date.
- **Trip detail (if screen exists):** GET `/api/rides/:id` for one ride.

### 3.3 Issues (Ride history)

| #  | Severity | Issue |
|----|----------|--------|
| R1 | Medium   | **Trip list `rating` is hardcoded 4.5.** Not from Ride or Driver rating. All trips show same rating. |
| R2 | Low      | **No realtime update for list.** When a ride’s status changes (e.g. completed), the history list does not update until the client refetches GET `/api/driver/trips`. |
| R3 | Low      | **No ride_id in trip card for deep link.** Response has `trip_id` (ride id); if UI needs ride id for “View detail”, it’s present. No additional issue if used correctly. |

---

## 4. Earnings

**Purpose:** Earnings summary (today/week/month/total), breakdown, and optionally a list of transactions.

### 4.1 Workflow

- **GET `/api/driver/earnings`** (Driver Bearer)
  - Loads driver with all `earnings` (DriverEarning), ordered by date desc.
  - **Today:** filter `e.date >= start of today (00:00)`; sum `netAmount`, count trips.
  - **Week:** `e.date >= today - 7 days`; same aggregation.
  - **Month:** `e.date >= monthStart` where `monthStart = today; monthStart.setMonth(today.getMonth() - 1)` (can be wrong across year boundary).
  - **Total:** `driver.totalEarnings`, `driver.totalRides`.
  - Each period returns: `amount`, `trips`, **hours_online** (hardcoded: 6.5 / 42 / 168 / 420), `average_per_trip`.
  - **breakdown:** `base_fare`, `distance_fare`, `time_fare`, `surge_bonus` = fixed percentages of `totalEarnings` (10%, 70%, 15%, 5%), **not** from actual fare components per ride.
  - **Does not return** a list of individual earning records (no “transaction list” or “earnings by ride” in response).

### 4.2 Components inside Earnings

- **Summary cards (today / week / month / total):** From GET `/api/driver/earnings` – amounts and trip counts are real; **hours_online** is not.
- **Breakdown (base/distance/time/surge):** From same endpoint – **estimated** from total, not real per-ride breakdown.
- **“Earnings list” / “Transaction history”:** No endpoint returns a paginated list of DriverEarning rows (ride id, date, amount, commission, net). Only aggregates are returned. If the UI has such a list, **there is no API for it**.

### 4.3 Issues (Earnings)

| #  | Severity | Issue |
|----|----------|--------|
| E1 | Medium   | **hours_online is hardcoded** (6.5, 42, 168, 420) for today/week/month/total. Not derived from driver activity or session data. |
| E2 | Medium   | **breakdown is estimated.** base_fare, distance_fare, time_fare, surge_bonus are 10%/70%/15%/5% of total earnings, not from actual ride-level fare components. |
| E3 | High    | **No list of individual earnings.** GET `/api/driver/earnings` returns only aggregates. If the Earnings screen has a “Recent earnings” or “Earnings by ride” list, there is **no backend endpoint** that returns that list (no paginated DriverEarning records). |
| E4 | Low     | **“Today” is calendar day (00:00–now),** not rolling “last 24 hours”. |
| E5 | Low     | **Month window** uses `setMonth(getMonth()-1)`, which can be wrong around year boundary (e.g. Jan → previous Dec). “Last 30 days” would be clearer. |
| E6 | Low     | **No explicit platform fee/commission** in the summary response; client must infer from (total fare − net) or from per-ride data if exposed. |

---

## 5. Settings

**Purpose:** Driver preferences, profile/account info, penalties, document/onboarding status.

### 5.1 Workflow

- **GET `/api/driver/profile`** – Same as Home; used for “Profile” or “Account” in Settings (name, phone, vehicle, documents, verification).
- **GET `/api/driver/onboarding/status`** (Bearer) – Returns onboarding_status, is_verified, documents_submitted, documents_verified, pending_documents, can_start_rides, verification_notes. Used for “Verification” or “Documents” in Settings.
- **GET `/api/driver/penalties`** (Driver Bearer) – List penalties (optional `?status=PENDING`), unpaidTotal, canGoOnline. Used for “Penalties” or “Pay dues” in Settings.
- **POST `/api/driver/penalties/pay`** (Driver Bearer) – Pay all unpaid penalties (marks PAID). Driver can then go online again.
- **Onboarding (if shown in Settings):** PUT language, PUT vehicle, POST document/upload, POST documents/submit – see onboarding section below. These are one-time onboarding; “Settings” might reuse them for “Edit vehicle” etc.

**No dedicated “driver settings” API** for things like: notification preferences, app language (separate from onboarding language), or “edit my name/email” (driver identity is User; auth has PUT `/api/auth/profile` for name/email, but that’s shared with passenger – no driver-specific profile update endpoint).

### 5.2 Components inside Settings

- **Profile / account:** Read-only from GET profile; **no driver-specific profile update** (name/email would be via auth profile if at all).
- **Verification / documents:** GET onboarding/status; upload via onboarding/document/upload. **documents/submit** requires LICENSE, PAN_CARD, RC, AADHAAR_CARD, PROFILE_PHOTO; DocumentType enum has these plus INSURANCE, PUC. If product expects only a subset, required list may not match.
- **Penalties:** GET penalties, POST penalties/pay. Workflow is complete for Stop Riding penalty.
- **Vehicle / language:** Onboarding PUT language, PUT vehicle – no separate “Settings: change vehicle” endpoint; same onboarding APIs.

### 5.3 Issues (Settings)

| #  | Severity | Issue |
|----|----------|--------|
| S1 | Medium   | **No dedicated driver “settings” or “preferences” API.** Notification preference, app language (if different from onboarding), or “edit profile” for driver are not clearly supported; profile is read-only from driver-service. |
| S2 | Low     | **Driver cannot update own profile (name, phone, vehicle) from driver-service.** Name/email can be updated via auth PUT `/api/auth/profile` (same user); vehicle/language are only in onboarding flow. If Settings has “Edit vehicle” or “Edit name”, either reuse onboarding endpoints or add explicit settings endpoints. |
| S3 | Low     | **documents/submit required list** (LICENSE, PAN_CARD, RC, AADHAAR_CARD, PROFILE_PHOTO) may not match onboarding upload flow (which only advances status for LICENSE and PROFILE_PHOTO in upload handler). Document types in schema include PUC, INSURANCE; product may expect different required set. |

---

## 6. Help and support

**Purpose:** Submit a support request and optionally see past requests.

### 6.1 Workflow

- **POST `/api/driver/support`** (Driver Bearer)  
  - Body: `issue_type` (required), `description` (required), `priority` (optional: low/medium/high).  
  - Returns 201 with a **stub object**: `request_id: support_${Date.now()}`, `driver_id`, `issue_type`, `description`, `priority`, `status: 'submitted'`, `created_at`.  
  - **Not persisted:** No SupportRequest (or similar) model; no DB write. Response is built in memory only.
- **List / track requests:** **No endpoint.** There is no GET for “my support tickets” or “support request status”.

### 6.2 Components inside Help and support

- **Submit form:** POST `/api/driver/support` – works for submission UX but **data is not stored**.
- **“My requests” / “Ticket status”:** No API; cannot show list or status of submitted requests.

### 6.3 Issues (Help and support)

| #  | Severity | Issue |
|----|----------|--------|
| HS1 | High    | **Support requests are not persisted.** POST `/api/driver/support` returns success and a fake request_id but does not save to DB. No model or table for support tickets; no way to track or follow up. |
| HS2 | High    | **No list or status API for support.** Driver cannot see “My support requests” or ticket status; no GET endpoint for support tickets. |
| HS3 | Low    | **request_id is not stable.** Uses `support_${Date.now()}`; if backend ever persisted, duplicate submits in same ms could collide; no unique id from DB. |

---

## 7. Onboarding (used by Settings / first-time flow)

Relevant for Settings when driver edits documents or vehicle:

- **POST `/api/driver/onboarding/start`** – Create or get driver, return onboarding_status.
- **PUT `/api/driver/onboarding/language`** – preferredLanguage, step EARNING_SETUP.
- **PUT `/api/driver/onboarding/vehicle`** – vehicleType, serviceTypes, step LICENSE_UPLOAD.
- **POST `/api/driver/onboarding/document/upload`** – Single file upload; documentType in body; advances status for LICENSE → PROFILE_PHOTO, PROFILE_PHOTO → PHOTO_CONFIRMATION.
- **POST `/api/driver/onboarding/documents/submit`** – Requires LICENSE, PAN_CARD, RC, AADHAAR_CARD, PROFILE_PHOTO; sets DOCUMENT_VERIFICATION.
- **GET `/api/driver/onboarding/status`** – Current step, verification, can_start_rides.

Already covered in Settings issues (S2, S3).

---

## 8. Enlisted Issues (Full List)

| #   | Menu / Area     | Severity | Issue |
|-----|-----------------|----------|--------|
| H1  | Home            | Medium   | Profile earnings.week and earnings.month are fake (0.3/0.7 of total), not real week/month. |
| H2  | Home            | Low      | Default location (28.61, 77.21) when driver has no lat/lng. |
| R1  | Ride history    | Medium   | Trip list rating is hardcoded 4.5 for every trip. |
| R2  | Ride history    | Low      | No realtime update for trip list; refetch required. |
| E1  | Earnings        | Medium   | hours_online is hardcoded (6.5, 42, 168, 420). |
| E2  | Earnings        | Medium   | breakdown is estimated (10%/70%/15%/5% of total), not real. |
| E3  | Earnings        | High     | No API returns list of individual earnings (transaction list). |
| E4  | Earnings        | Low      | “Today” is calendar day, not last 24 hours. |
| E5  | Earnings        | Low      | Month window uses setMonth(-1); wrong around year boundary. |
| E6  | Earnings        | Low      | No explicit platform fee/commission in summary. |
| S1  | Settings        | Medium   | No dedicated driver settings/preferences API. |
| S2  | Settings        | Low      | No driver-service endpoint to update profile/vehicle; auth profile and onboarding only. |
| S3  | Settings        | Low      | documents/submit required list may not match upload flow / product. |
| HS1 | Help and support| High     | Support requests not persisted (no DB save). |
| HS2 | Help and support| High     | No GET for “my support requests” or ticket status. |
| HS3 | Help and support| Low     | request_id is timestamp-based, not DB-backed. |

---

## 9. Summary Table – Menu vs Backend Support

| Menu           | List/read support        | Detail/transaction list     | Create/update support       | Issues |
|----------------|--------------------------|-----------------------------|-----------------------------|--------|
| **Home**       | GET profile, GET status  | -                            | PATCH status                | Fake week/month earnings (H1), default location (H2). |
| **Ride history** | GET trips (paginated)  | GET /api/rides/:id           | -                           | Hardcoded rating (R1), no push (R2). |
| **Earnings**   | GET earnings (aggregates)| **None** (no per-record list) | -                           | Hardcoded hours (E1), estimated breakdown (E2), no list API (E3), time windows (E4,E5,E6). |
| **Settings**   | GET profile, GET onboarding/status, GET penalties | - | POST penalties/pay, onboarding APIs | No settings API (S1), no profile/vehicle update (S2), doc required list (S3). |
| **Help and support** | **None** (no list)   | **None**                     | POST support (not persisted)| Not saved (HS1), no list/status (HS2), request_id (HS3). |

---

**Document version:** 1.0  
**Scope:** Driver hamburger menu and components; no code changes.
