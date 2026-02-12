# Fare Calculation, Surge Calculation & Geo-Tagged Notifications Documentation

**Date:** February 8, 2026  
**Status:** Documentation Only (No Code Changes)

---

## 1. Geo-Tagged Notifications

### Current Status: ❌ **NOT IMPLEMENTED**

**Analysis:**
- The `Notification` model in `prisma/schema.prisma` does **NOT** have latitude/longitude fields
- No functionality exists to send notifications based on user location or geographic areas
- Notifications are currently only user-specific (tied to `userId`)

**Current Notification Schema:**
```prisma
model Notification {
  id                String    @id @default(cuid())
  userId            String
  title             String
  message           String
  type              NotificationType  // RIDE_UPDATE, PAYMENT, PROMOTION, SYSTEM, SUPPORT
  isRead            Boolean   @default(false)
  data              Json?     // Optional metadata
  createdAt         DateTime  @default(now())
  
  // NO latitude/longitude fields
  // NO geographic targeting capability
}
```

**What Would Be Needed for Geo-Tagged Notifications:**
1. Add `latitude` and `longitude` fields to `Notification` model (optional, for location-based notifications)
2. Add `targetRadius` field (in km) for geographic targeting
3. Create endpoint: `POST /api/notifications/internal/create-geo` that:
   - Accepts `latitude`, `longitude`, `radius`, `title`, `message`, `type`
   - Queries users within radius using their saved locations or last known location
   - Creates notifications for all matching users
4. Store user's last known location (from ride requests or app location updates)
5. Query logic to find users within geographic bounds

**Current Notification Endpoints:**
- `GET /api/notifications` - List user's notifications (paginated)
- `POST /api/notifications/:id/read` - Mark notification as read
- `POST /api/notifications/read-all` - Mark all as read
- `DELETE /api/notifications/:id` - Delete notification
- `POST /api/notifications/internal/create` - Create notification for specific user (internal API)

**Conclusion:** Geo-tagged notifications are **NOT working** and would require significant implementation.

---

## 2. Fare Calculation

### Status: ✅ **FULLY IMPLEMENTED**

**Location:** `services/pricing-service/src/pricingService.ts`

### 2.1 Fare Calculation Formula

**Total Fare Calculation:**
```
Subtotal = Base Fare + Distance Fare + Time Fare
Total Fare = Subtotal × Surge Multiplier × Peak Hour Multiplier
```

### 2.2 Components Breakdown

#### **Base Fare**
- **Source:** `PricingRule.baseFare` (from database) or `BASE_FARE` env var (default: ₹25)
- **Fixed amount** charged for every ride regardless of distance/time
- **Default:** ₹25

#### **Distance Fare**
- **Formula:** `Distance (km) × Per Km Rate`
- **Per Km Rate:** `PricingRule.perKmRate` or `PER_KM_RATE` env var (default: ₹12/km)
- **Distance Calculation:** Uses `geolib.getDistance()` (Haversine formula)
  - Calculates straight-line distance between pickup and drop coordinates
  - Returns distance in meters, converted to kilometers
- **Example:** 5 km × ₹12/km = ₹60

#### **Time Fare**
- **Formula:** `Estimated Duration (minutes) × Per Minute Rate`
- **Per Minute Rate:** `PricingRule.perMinuteRate` or `PER_MINUTE_RATE` env var (default: ₹2/minute)
- **Duration Estimation:** `Math.ceil((distance / 25) * 60)`
  - Assumes average speed of 25 km/h
  - Converts to minutes and rounds up
- **Example:** 12 minutes × ₹2/min = ₹24

### 2.3 Multipliers Applied

#### **Surge Multiplier**
- Applied to subtotal (base + distance + time)
- Range: 1.0 to unlimited (see Surge Calculation section below)
- **Surge Amount:** `Subtotal × (Surge Multiplier - 1)`
- Example: If subtotal = ₹100, surge = 1.5x → Surge Amount = ₹50

#### **Peak Hour Multiplier**
- Applied after surge multiplier
- **Peak Hours:** 7:00 AM - 9:00 AM and 5:00 PM - 8:00 PM
- **Multiplier:** 1.5x during peak hours, 1.0x otherwise
- **Peak Hour Amount:** `Subtotal × (Peak Hour Multiplier - 1)`
- Example: If subtotal = ₹100, peak hour = 1.5x → Peak Hour Amount = ₹50

**Note:** Both multipliers are **multiplicative**, not additive:
- If surge = 1.2x and peak hour = 1.5x
- Total multiplier = 1.2 × 1.5 = 1.8x

### 2.4 Complete Calculation Example

**Input:**
- Pickup: (28.6139°N, 77.2090°E) - Delhi
- Drop: (28.7041°N, 77.1025°E) - Noida
- Distance: ~15 km
- Time: 8:00 AM (peak hour)
- Surge: 1.2x (from surge area)

**Calculation:**
```
Base Fare: ₹25
Distance Fare: 15 km × ₹12/km = ₹180
Estimated Duration: ceil((15 / 25) × 60) = 36 minutes
Time Fare: 36 min × ₹2/min = ₹72

Subtotal = ₹25 + ₹180 + ₹72 = ₹277

Surge Multiplier: 1.2x
Peak Hour Multiplier: 1.5x (8:00 AM is peak hour)

Total Fare = ₹277 × 1.2 × 1.5 = ₹498.60
Rounded to 2 decimals: ₹498.60

Breakdown:
- Base Fare: ₹25.00
- Distance Fare: ₹180.00
- Time Fare: ₹72.00
- Surge Amount: ₹277 × (1.2 - 1) = ₹55.40
- Peak Hour Amount: ₹277 × (1.5 - 1) = ₹138.50
- Subtotal: ₹277.00
- Total: ₹498.60
```

### 2.5 Pricing Rule Priority

**Priority Order:**
1. **Database `PricingRule`** (if exists and active)
   - Must have `isActive = true`
   - Must have `validFrom <= now`
   - Must have `validTo = null` OR `validTo >= now`
   - Ordered by `createdAt DESC` (most recent first)
2. **Environment Variables** (fallback if no active rule)
   - `BASE_FARE` (default: 25)
   - `PER_KM_RATE` (default: 12)
   - `PER_MINUTE_RATE` (default: 2)

### 2.6 API Endpoint

**Endpoint:** `POST /api/pricing/calculate`

**Request:**
```json
{
  "pickupLat": 28.6139,
  "pickupLng": 77.2090,
  "dropLat": 28.7041,
  "dropLng": 77.1025,
  "vehicleType": "SEDAN",  // Optional
  "scheduledTime": "2026-02-08T08:00:00Z"  // Optional, ISO string
}
```

**Response:**
```json
{
  "baseFare": 25,
  "distanceFare": 180,
  "timeFare": 72,
  "surgeMultiplier": 1.2,
  "peakHourMultiplier": 1.5,
  "totalFare": 498.60,
  "distance": 15.0,
  "estimatedDuration": 36,
  "breakdown": {
    "baseFare": 25,
    "distanceFare": 180,
    "timeFare": 72,
    "surgeAmount": 55.40,
    "peakHourAmount": 138.50,
    "subtotal": 277,
    "total": 498.60
  }
}
```

### 2.7 Fare Storage in Ride

When a ride is created, all fare components are stored in the `Ride` model:
- `baseFare` - Base fare amount
- `distanceFare` - Distance-based fare
- `timeFare` - Time-based fare
- `surgeMultiplier` - Surge multiplier applied
- `surgeFare` - Calculated surge amount (stored separately for earnings)
- `totalFare` - Final total fare

**Note:** The fare is calculated **once** at ride creation and stored. It does NOT recalculate if:
- Surge changes during the ride
- Actual duration differs from estimated duration
- Actual distance differs from calculated distance

---

## 3. Surge Calculation

### Status: ✅ **IMPLEMENTED** (Basic Implementation)

**Location:** `services/pricing-service/src/pricingService.ts` - `calculateSurgeMultiplier()`

### 3.1 Surge Calculation Logic

**Priority Order:**

1. **Surge Area (Database)**
   - Checks for active `SurgeArea` records in database
   - Matches if pickup location is within ±0.01° (~1.1 km) of surge area center
   - Returns `SurgeArea.multiplier` if match found
   - **Priority:** Highest (overrides time-based surge)

2. **Time-Based Surge (Fallback)**
   - If no surge area matches:
     - **Peak Hours:** 7:00 AM - 9:00 AM OR 5:00 PM - 8:00 PM
     - **Multiplier:** 1.2x
   - **Off-Peak:** 1.0x (no surge)

### 3.2 Surge Area Model

**Schema:**
```prisma
model SurgeArea {
  id                String    @id @default(cuid())
  name              String
  centerLatitude    Float
  centerLongitude   Float
  radius            Float     // in kilometers
  multiplier        Float     // e.g., 1.5, 2.0, 2.5
  isActive          Boolean   @default(true)
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
}
```

**Matching Logic:**
- Checks if `pickupLat` is within `[centerLatitude - 0.01, centerLatitude + 0.01]`
- Checks if `pickupLng` is within `[centerLongitude - 0.01, centerLongitude + 0.01]`
- **Note:** This is a simple bounding box check, NOT a radius check
- **Issue:** The `radius` field in `SurgeArea` is stored but **NOT used** in the matching logic

### 3.3 Current Limitations

**Issues Identified:**

1. **No Dynamic Surge Based on Demand**
   - Surge is NOT calculated based on:
     - Number of available drivers vs. active ride requests
     - Real-time demand ratio
     - Driver availability in the area
   - Currently only uses static surge areas or fixed time-based surge

2. **Surge Area Matching is Inaccurate**
   - Uses fixed ±0.01° bounding box (~1.1 km)
   - Does NOT use the `radius` field from `SurgeArea` model
   - Should use proper distance calculation (Haversine) with radius

3. **No Surge Based on Driver Density**
   - The `realtime-service` has `getLocationStats()` that calculates:
     - `availableDrivers` - Drivers online in area
     - `activeRides` - Active ride requests in area
     - `demandRatio` - `activeRides / availableDrivers`
   - **This data is NOT used** for surge calculation

4. **No Maximum Surge Cap**
   - No `SURGE_MULTIPLIER_MAX` enforcement in calculation
   - Environment variable `SURGE_MULTIPLIER_MAX=3.0` exists but is NOT used

5. **Surge Not Updated During Ride**
   - Surge is calculated once at ride creation
   - If surge increases/decreases during ride, it's not reflected
   - Ride fare is locked at creation time

### 3.4 Recommended Improvements

**For Dynamic Surge Calculation:**

1. **Use Demand Ratio:**
   ```typescript
   const demandRatio = activeRides / availableDrivers;
   let surgeMultiplier = 1.0;
   
   if (demandRatio > 2.0) surgeMultiplier = 2.5;  // High demand
   else if (demandRatio > 1.5) surgeMultiplier = 2.0;
   else if (demandRatio > 1.0) surgeMultiplier = 1.5;
   else if (demandRatio > 0.5) surgeMultiplier = 1.2;
   ```

2. **Fix Surge Area Matching:**
   ```typescript
   const distance = calcDistance(lat, lng, surgeArea.centerLatitude, surgeArea.centerLongitude);
   if (distance <= surgeArea.radius) {
     return surgeArea.multiplier;
   }
   ```

3. **Apply Maximum Surge Cap:**
   ```typescript
   const MAX_SURGE = parseFloat(process.env.SURGE_MULTIPLIER_MAX || '3.0');
   surgeMultiplier = Math.min(surgeMultiplier, MAX_SURGE);
   ```

4. **Combine Multiple Factors:**
   - Surge Area (if exists)
   - Demand Ratio (dynamic)
   - Peak Hours (time-based)
   - Take the maximum of all applicable surges

### 3.5 Current Surge Values

**Static Surge Areas:**
- Managed via database (admin can create/update)
- Multiplier can be any value (typically 1.5x - 3.0x)

**Time-Based Surge:**
- Peak Hours (7-9 AM, 5-8 PM): 1.2x
- Off-Peak: 1.0x

**Default (No Match):**
- 1.0x (no surge)

---

## 4. Summary

### Geo-Tagged Notifications
- ❌ **NOT IMPLEMENTED**
- No location-based notification functionality
- Would require schema changes and new endpoint

### Fare Calculation
- ✅ **FULLY WORKING**
- Formula: `(Base + Distance + Time) × Surge × Peak Hour`
- All components properly calculated and stored
- Breakdown provided in API response

### Surge Calculation
- ⚠️ **BASIC IMPLEMENTATION** (Static Only)
- Uses surge areas (database) or time-based surge (1.2x peak hours)
- **Missing:** Dynamic surge based on demand/driver availability
- **Missing:** Proper radius-based surge area matching
- **Missing:** Maximum surge cap enforcement

---

## 5. Files Referenced

- `services/pricing-service/src/pricingService.ts` - Fare & surge calculation
- `services/notification-service/src/index.ts` - Notification endpoints
- `prisma/schema.prisma` - Database models (Notification, SurgeArea, PricingRule, Ride)
- `services/realtime-service/src/realtimeService.ts` - Location stats (not used for surge)

---

**End of Documentation**
