/**
 * Vehicle / service-line catalog and dispatch compatibility rules.
 *
 * This is the single source of truth for how ride requests map to eligible
 * drivers across the platform (pricing supply filtering + ride dispatch +
 * realtime matching).
 *
 * Product lines (categories) are intentionally separate so they can evolve
 * independently, the way Uber/Ola/Rapido model distinct products:
 *   - bike            : two-wheeler taxi + roadside rescue
 *   - auto            : auto-rickshaw
 *   - cab             : four-wheeler taxi, internally tiered (mini < xl < premium)
 *   - personal_driver : "hire a driver" / chauffeur — the customer owns the car,
 *                       the driver brings no vehicle. This is a DISTINCT product
 *                       from cabs and must never be cross-dispatched with them.
 *
 * Independent drivers (no vehicle) are matched via their `serviceTypes`, not via
 * a vehicle category, so a chauffeur can never be sent a real cab trip.
 */

import { INDEPENDENT_DRIVER_VEHICLE_TYPE } from './driverVerification';

export type ServiceCategory = 'bike' | 'auto' | 'cab' | 'personal_driver';

interface VehicleTypeDef {
  category: ServiceCategory;
  /** Ranking within a category for downward-compatible dispatch (cab only). 0 = not tiered. */
  tier: number;
}

/**
 * Canonical catalog of concrete vehicle types → product category + tier.
 * Add new vehicle types here; dispatch logic derives everything from this map.
 */
const VEHICLE_CATALOG: Record<string, VehicleTypeDef> = {
  // Bike / rescue
  bike: { category: 'bike', tier: 0 },
  bike_taxi: { category: 'bike', tier: 0 },
  bike_rescue: { category: 'bike', tier: 0 },
  motorbike: { category: 'bike', tier: 0 },

  // Auto-rickshaw
  auto: { category: 'auto', tier: 0 },

  // Cab tiers (downward-compatible: higher tier can serve lower tier requests)
  cab: { category: 'cab', tier: 1 },
  cab_mini: { category: 'cab', tier: 1 },
  cab_sedan: { category: 'cab', tier: 1 },
  commercial_car: { category: 'cab', tier: 1 },
  cab_xl: { category: 'cab', tier: 2 },
  cab_suv: { category: 'cab', tier: 2 },
  cab_premium: { category: 'cab', tier: 3 },

  // Hire-a-driver / chauffeur (separate product line, no vehicle owned)
  personal_driver: { category: 'personal_driver', tier: 0 },
};

const BIKE_TYPES = Object.keys(VEHICLE_CATALOG).filter((t) => VEHICLE_CATALOG[t].category === 'bike');
const CAB_TYPES = Object.keys(VEHICLE_CATALOG).filter((t) => VEHICLE_CATALOG[t].category === 'cab');

/**
 * Maps an independent driver's `serviceTypes` entry to the product category it fulfils.
 * Independent drivers are matched by these specific services, never by broad category.
 */
const SERVICE_TO_CATEGORY: Record<string, ServiceCategory> = {
  personal_driver: 'personal_driver',
  bike_rescue: 'bike',
};

function normalizeSlug(raw: string | null | undefined): string {
  return (raw || '').toLowerCase().trim().replace(/-/g, '_');
}

function normalizeServiceTypes(serviceTypes?: string[] | null): string[] {
  return (serviceTypes || []).map((value) => value.toLowerCase().trim());
}

function isIndependentDriver(vehicleType: string | null | undefined): boolean {
  return normalizeSlug(vehicleType) === INDEPENDENT_DRIVER_VEHICLE_TYPE;
}

function catalogEntry(vehicleType: string | null | undefined): VehicleTypeDef | null {
  return VEHICLE_CATALOG[normalizeSlug(vehicleType)] ?? null;
}

/** Product category for a concrete vehicle type (null for unknown / independent). */
export function getServiceCategory(vehicleType: string | null | undefined): ServiceCategory | null {
  if (isIndependentDriver(vehicleType)) return null;
  return catalogEntry(vehicleType)?.category ?? null;
}

/**
 * Legacy-compatible category accessor used by dispatch code paths.
 * Returns the product category, or null for unknown/independent types.
 */
export function normalizeVehicleType(
  raw: string | null | undefined,
): ServiceCategory | null {
  return getServiceCategory(raw);
}

/**
 * Downward-compatible dispatch tier. Meaningful for cabs only; every other
 * category returns 0. Independent drivers are 0 (matched via serviceTypes).
 */
export function getVehicleRank(
  vehicleType: string | null | undefined,
  _serviceTypes?: string[] | null,
): number {
  if (isIndependentDriver(vehicleType)) return 0;
  const entry = catalogEntry(vehicleType);
  return entry && entry.category === 'cab' ? entry.tier : 0;
}

function independentDriverSupports(
  serviceTypes: string[] | null | undefined,
  rideValue: string,
): boolean {
  const services = normalizeServiceTypes(serviceTypes);
  for (const svc of services) {
    const cat = SERVICE_TO_CATEGORY[svc];
    if (!cat) continue;
    if (cat === 'personal_driver' && rideValue === 'personal_driver') return true;
    if (cat === 'bike' && BIKE_TYPES.includes(rideValue)) return true;
  }
  return false;
}

/**
 * Core rule: can a driver of `driverVehicleType` (with optional serviceTypes)
 * serve a ride requesting `rideVehicleType`?
 *
 * @param allowUnknownRide when the ride type is unrecognised, `true` keeps the
 *   dispatch fail-open (used by broadcast paths), `false` requires an exact
 *   string match (used by pricing supply filtering).
 */
function canDriverServe(
  rideVehicleType: string | null | undefined,
  driverVehicleType: string | null | undefined,
  driverServiceTypes: string[] | null | undefined,
  allowUnknownRide: boolean,
): boolean {
  const rideValue = normalizeSlug(rideVehicleType);

  // Independent drivers: matched strictly by the specific services they offer.
  if (isIndependentDriver(driverVehicleType)) {
    return independentDriverSupports(driverServiceTypes, rideValue);
  }

  const rideCat = getServiceCategory(rideVehicleType);
  if (!rideCat) {
    return allowUnknownRide ? true : rideValue === normalizeSlug(driverVehicleType);
  }

  const driverCat = getServiceCategory(driverVehicleType);
  if (!driverCat) return false;
  if (driverCat !== rideCat) return false;

  // Cabs: downward-compatible (a higher-tier driver can serve lower-tier rides).
  if (rideCat === 'cab') {
    return getVehicleRank(driverVehicleType) >= getVehicleRank(rideVehicleType);
  }

  // All other product lines: strict same-category match.
  return true;
}

/**
 * Dispatch-side check: should this ride be offered to this driver?
 * Fail-open for unknown ride types (never silently drop a broadcast).
 */
export function isDriverCompatibleForRide(
  rideVehicleType: string | null | undefined,
  driverVehicleType: string | null | undefined,
  driverServiceTypes?: string[] | null,
): boolean {
  return canDriverServe(rideVehicleType, driverVehicleType, driverServiceTypes, true);
}

/**
 * Supply-side check: does this driver count as available supply for a given
 * requested vehicle type? Stricter (exact match) for unknown types.
 */
export function isDriverEligibleForVehicleType(
  driverVehicleType: string,
  requestVehicleType: string,
  driverServiceTypes?: string[] | null,
): boolean {
  return canDriverServe(requestVehicleType, driverVehicleType, driverServiceTypes, false);
}

/**
 * DB-query pre-filter: the set of driver vehicleType values that could possibly
 * serve a request. This is a *superset* (final eligibility is decided by
 * isDriverEligibleForVehicleType), used to keep the geospatial query cheap.
 */
export function getNearbyDriverVehicleTypeFilter(requestVehicleType: string): string[] {
  const requestValue = normalizeSlug(requestVehicleType);
  const reqCat = getServiceCategory(requestVehicleType);

  switch (reqCat) {
    case 'bike':
      return [...BIKE_TYPES, INDEPENDENT_DRIVER_VEHICLE_TYPE];
    case 'auto':
      return ['auto'];
    case 'personal_driver':
      return ['personal_driver', INDEPENDENT_DRIVER_VEHICLE_TYPE];
    case 'cab': {
      const reqTier = getVehicleRank(requestVehicleType);
      return CAB_TYPES.filter((t) => VEHICLE_CATALOG[t].tier >= reqTier);
    }
    default:
      return [requestVehicleType];
  }
}
