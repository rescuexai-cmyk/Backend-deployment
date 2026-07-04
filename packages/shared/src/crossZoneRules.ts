/**
 * Cross-zone vehicle permit restrictions (e.g. auto cannot cross Delhi-UP border).
 */

import { prisma } from './database';
import {
  areCoordinatesInSameOperationalZone,
  getOperationalZoneFromCoordinates,
  normalizeCity,
} from './cityUtils';
import { resolveZone } from './zoneService';

export class CrossZoneBlockedError extends Error {
  statusCode = 422;
  isOperational = true;
  code = 'CROSS_ZONE_VEHICLE_BLOCKED';
  origin: string;
  destination: string;
  vehicleType: string;

  constructor(params: {
    origin: string;
    destination: string;
    vehicleType: string;
    reason?: string | null;
  }) {
    const message =
      params.reason ||
      `${params.vehicleType} is not permitted from ${params.origin} to ${params.destination}.`;
    super(message);
    this.name = 'CrossZoneBlockedError';
    this.origin = params.origin;
    this.destination = params.destination;
    this.vehicleType = params.vehicleType;
  }
}

export interface CrossZoneBlockResult {
  blocked: boolean;
  reason?: string | null;
}

function normalizeVehicleTypeSlug(vehicleType: string): string {
  return vehicleType.toLowerCase().trim().replace(/-/g, '_');
}

/** NCR zones where auto / bike_rescue cannot cross into a different zone. */
const NCR_OPERATIONAL_ZONES = new Set(['delhi', 'gurgaon', 'noida', 'ghaziabad', 'faridabad']);
const NCR_CROSS_BORDER_BLOCKED_VEHICLES = ['auto', 'bike_rescue'];

function isNcrCrossBorderRoute(origin: string, destination: string): boolean {
  const o = normalizeCity(origin);
  const d = normalizeCity(destination);
  return o !== d && NCR_OPERATIONAL_ZONES.has(o) && NCR_OPERATIONAL_ZONES.has(d);
}

function defaultNcrBlockReason(vehicleType: string): string {
  if (vehicleType === 'auto') {
    return 'Auto-rickshaws do not have a permit to cross NCR zone/state borders.';
  }
  return 'Two-wheeler rescue services are restricted from crossing NCR zone borders.';
}

// ─── Rule cache ───────────────────────────────────────────────────────────────
// Cross-zone rules change rarely, but are read on every quote and booking.
// Cache the (small) blocked-rule set with a short TTL to avoid hammering the DB.

interface CachedBlockRule {
  origin: string;
  destination: string;
  vehicleType: string;
  reason: string | null;
}

const RULES_CACHE_TTL_MS = Number(process.env.CROSS_ZONE_CACHE_TTL_MS ?? 60 * 1000);

let rulesCache: { rules: CachedBlockRule[]; expiresAt: number } | null = null;
let rulesCacheInflight: Promise<CachedBlockRule[]> | null = null;

async function loadBlockedRules(): Promise<CachedBlockRule[]> {
  if (rulesCache && rulesCache.expiresAt > Date.now()) {
    return rulesCache.rules;
  }
  if (rulesCacheInflight) {
    return rulesCacheInflight;
  }

  rulesCacheInflight = (async () => {
    try {
      const rows = await prisma.crossZoneRule.findMany({
        where: { isAllowed: false },
        select: { origin: true, destination: true, vehicleType: true, reason: true },
      });
      const rules: CachedBlockRule[] = rows.map((r) => ({
        origin: normalizeCity(r.origin),
        destination: normalizeCity(r.destination),
        vehicleType: normalizeVehicleTypeSlug(r.vehicleType),
        reason: r.reason ?? null,
      }));
      rulesCache = { rules, expiresAt: Date.now() + RULES_CACHE_TTL_MS };
      return rules;
    } finally {
      rulesCacheInflight = null;
    }
  })();

  return rulesCacheInflight;
}

/**
 * Invalidate the in-process cross-zone rule cache.
 * Call after creating/updating/deleting a rule so changes take effect immediately
 * within the same process (other processes refresh within the TTL window).
 */
export function invalidateCrossZoneCache(): void {
  rulesCache = null;
}

/**
 * Lookup an explicit block rule for a normalized origin/destination/vehicle route.
 */
export async function getCrossZoneBlock(
  origin: string,
  destination: string,
  vehicleType: string,
): Promise<CrossZoneBlockResult> {
  const normalizedOrigin = normalizeCity(origin);
  const normalizedDestination = normalizeCity(destination);
  const normalizedVehicle = normalizeVehicleTypeSlug(vehicleType);

  if (normalizedOrigin === normalizedDestination) {
    return { blocked: false };
  }

  const rules = await loadBlockedRules();
  const match = rules.find(
    (r) =>
      r.origin === normalizedOrigin &&
      r.destination === normalizedDestination &&
      r.vehicleType === normalizedVehicle,
  );

  if (match) {
    return { blocked: true, reason: match.reason };
  }

  if (
    isNcrCrossBorderRoute(normalizedOrigin, normalizedDestination) &&
    NCR_CROSS_BORDER_BLOCKED_VEHICLES.includes(normalizedVehicle)
  ) {
    return { blocked: true, reason: defaultNcrBlockReason(normalizedVehicle) };
  }

  return { blocked: false };
}

export async function isVehicleAllowedForRoute(
  origin: string,
  destination: string,
  vehicleType: string,
): Promise<boolean> {
  const block = await getCrossZoneBlock(origin, destination, vehicleType);
  return !block.blocked;
}

export async function getBlockedVehicleTypesForRoute(
  origin: string,
  destination: string,
): Promise<Set<string>> {
  const normalizedOrigin = normalizeCity(origin);
  const normalizedDestination = normalizeCity(destination);

  if (normalizedOrigin === normalizedDestination) {
    return new Set();
  }

  const rules = await loadBlockedRules();
  const blocked = new Set(
    rules
      .filter((r) => r.origin === normalizedOrigin && r.destination === normalizedDestination)
      .map((r) => r.vehicleType),
  );

  if (isNcrCrossBorderRoute(normalizedOrigin, normalizedDestination)) {
    for (const vt of NCR_CROSS_BORDER_BLOCKED_VEHICLES) {
      blocked.add(vt);
    }
  }

  return blocked;
}

/**
 * Throws CrossZoneBlockedError when the vehicle type is not permitted on this route.
 */
export async function assertVehicleAllowedForRoute(params: {
  origin: string;
  destination: string;
  vehicleType: string;
}): Promise<void> {
  const block = await getCrossZoneBlock(params.origin, params.destination, params.vehicleType);
  if (block.blocked) {
    throw new CrossZoneBlockedError({
      origin: normalizeCity(params.origin),
      destination: normalizeCity(params.destination),
      vehicleType: normalizeVehicleTypeSlug(params.vehicleType),
      reason: block.reason,
    });
  }
}

/**
 * Resolve zones from coordinates and enforce cross-zone vehicle restrictions.
 * Zone resolution uses H3 geofences with graceful fallback to geocoded cities.
 */
export async function assertVehicleAllowedForCoordinates(params: {
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  vehicleType: string;
}): Promise<{ origin: string; destination: string }> {
  // Noida ↔ Greater Noida (same UP district) must never trigger Delhi–UP border rules.
  if (
    areCoordinatesInSameOperationalZone(
      params.pickupLat,
      params.pickupLng,
      params.dropLat,
      params.dropLng,
    )
  ) {
    const zone =
      getOperationalZoneFromCoordinates(params.pickupLat, params.pickupLng) ?? 'noida';
    return { origin: zone, destination: zone };
  }

  const [origin, destination] = await Promise.all([
    resolveZone(params.pickupLat, params.pickupLng),
    resolveZone(params.dropLat, params.dropLng),
  ]);

  await assertVehicleAllowedForRoute({
    origin,
    destination,
    vehicleType: params.vehicleType,
  });

  return { origin, destination };
}

/**
 * Coordinate-based blocked-vehicle lookup. Resolves both endpoints to zones and
 * returns the set of vehicle types not permitted on that route.
 */
export async function getBlockedVehicleTypesForCoordinates(
  pickupLat: number,
  pickupLng: number,
  dropLat: number,
  dropLng: number,
): Promise<{ origin: string; destination: string; blocked: Set<string> }> {
  // Same operational zone (e.g. Noida ↔ Greater Noida) — no cross-border blocks.
  if (areCoordinatesInSameOperationalZone(pickupLat, pickupLng, dropLat, dropLng)) {
    const zone = getOperationalZoneFromCoordinates(pickupLat, pickupLng) ?? 'noida';
    return { origin: zone, destination: zone, blocked: new Set() };
  }

  const [origin, destination] = await Promise.all([
    resolveZone(pickupLat, pickupLng),
    resolveZone(dropLat, dropLng),
  ]);
  const blocked = await getBlockedVehicleTypesForRoute(origin, destination);
  return { origin, destination, blocked };
}
