/**
 * Intercity route classification — backend-driven, config-first.
 *
 * A route longer than the configured threshold is an "intercity" trip.
 * City products are not offered on such routes; instead the API returns a
 * single Intercity product descriptor. While intercity is not launched the
 * descriptor is flagged comingSoon and ride creation rejects these routes.
 *
 * Ops can tune everything without a deploy via platform_config key
 * "intercity_config_v1", e.g.:
 *   { "thresholdKm": 50, "enabled": false, "comingSoon": true,
 *     "name": "Intercity", "description": "Outstation trips between cities",
 *     "message": "Intercity is coming soon" }
 */

import { prisma, createLogger, getCityFromCoordinates, normalizeCity } from '@raahi/shared';

const logger = createLogger('pricing-service:intercity');

export interface IntercityConfig {
  thresholdKm: number;
  /** Once intercity launches, flip to true and stop short-circuiting pricing. */
  enabled: boolean;
  comingSoon: boolean;
  name: string;
  description: string;
  message: string;
  /**
   * Zones that form a single metro region. Trips between zones of the same
   * region are NEVER intercity regardless of route length (e.g. Gurgaon →
   * Faridabad is ~55km by road but both are NCR).
   */
  metroRegions: Record<string, string[]>;
}

export const DEFAULT_INTERCITY_CONFIG: IntercityConfig = {
  thresholdKm: 50,
  enabled: false,
  comingSoon: true,
  name: 'Intercity',
  description: 'Outstation trips between cities',
  message: 'Intercity is coming soon',
  metroRegions: {
    ncr: [
      'delhi',
      'new delhi',
      'gurgaon',
      'gurugram',
      'faridabad',
      'noida',
      'greater noida',
      'ghaziabad',
      'gautam buddha nagar',
    ],
  },
};

const CONFIG_KEY = 'intercity_config_v1';
const CACHE_TTL_MS = Number(process.env.INTERCITY_CONFIG_CACHE_TTL_MS ?? 60_000);

let cache: { config: IntercityConfig; expiresAt: number } | null = null;

export async function getIntercityConfig(): Promise<IntercityConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.config;

  let config = DEFAULT_INTERCITY_CONFIG;
  try {
    const row = await prisma.platformConfig.findUnique({
      where: { key: CONFIG_KEY },
    });
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Partial<IntercityConfig>;
      config = { ...DEFAULT_INTERCITY_CONFIG, ...parsed };
    }
  } catch (error) {
    logger.warn(`[INTERCITY] Failed to load ${CONFIG_KEY}, using defaults: ${error}`);
  }

  cache = { config, expiresAt: Date.now() + CACHE_TTL_MS };
  return config;
}

export function invalidateIntercityConfigCache(): void {
  cache = null;
}

/**
 * Thrown by fare calculation when the route is intercity and the intercity
 * product is not yet enabled. Handlers translate this into a structured
 * "coming soon" API response (pricing) or a 422 rejection (booking).
 */
export class IntercityRouteError extends Error {
  statusCode = 422;
  isOperational = true;
  code = 'INTERCITY_NOT_AVAILABLE';
  distanceKm: number;
  durationMin: number;
  config: IntercityConfig;

  constructor(params: { distanceKm: number; durationMin: number; config: IntercityConfig }) {
    super(params.config.message);
    this.name = 'IntercityRouteError';
    this.distanceKm = params.distanceKm;
    this.durationMin = params.durationMin;
    this.config = params.config;
  }
}

/** Region id for a zone/city slug, or null when it's not part of any metro region. */
function metroRegionFor(config: IntercityConfig, zone: string): string | null {
  const normalized = normalizeCity(zone);
  for (const [region, zones] of Object.entries(config.metroRegions || {})) {
    if (zones.some((z) => normalizeCity(z) === normalized)) return region;
  }
  return null;
}

/** True when both endpoints belong to the same metro region (e.g. both NCR). */
export function isSameMetroRegion(
  config: IntercityConfig,
  originZone: string | null | undefined,
  destinationZone: string | null | undefined,
): boolean {
  if (!originZone || !destinationZone) return false;
  const originRegion = metroRegionFor(config, originZone);
  return originRegion !== null && originRegion === metroRegionFor(config, destinationZone);
}

/**
 * Assert a route is NOT an unbookable intercity trip.
 * No-op when intercity is enabled (launched), under the distance threshold,
 * or when both endpoints are within the same metro region (e.g. anywhere in
 * NCR — Gurgaon → Faridabad must stay a regular city trip).
 *
 * Zones are taken from the caller when already resolved; otherwise both
 * endpoints are reverse-geocoded here (cached in cityUtils).
 */
export async function assertNotUnavailableIntercity(params: {
  distanceKm: number;
  durationMin: number;
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  originZone?: string | null;
  destinationZone?: string | null;
}): Promise<void> {
  const { distanceKm, durationMin } = params;
  const config = await getIntercityConfig();
  if (config.enabled) return;
  if (distanceKm <= config.thresholdKm) return;

  // Over the threshold — check whether this is still an intra-metro trip.
  let origin = params.originZone ?? null;
  let destination = params.destinationZone ?? null;
  try {
    if (!origin) origin = await getCityFromCoordinates(params.pickupLat, params.pickupLng);
    if (!destination) destination = await getCityFromCoordinates(params.dropLat, params.dropLng);
  } catch (error) {
    logger.warn(`[INTERCITY] Zone resolution failed, falling back to distance-only check: ${error}`);
  }

  if (isSameMetroRegion(config, origin, destination)) {
    logger.info(
      `[INTERCITY] ${distanceKm.toFixed(1)}km trip ${origin} -> ${destination} is intra-metro; not intercity`,
    );
    return;
  }

  logger.info(
    `[INTERCITY] Route classified intercity: ${distanceKm.toFixed(1)}km > ${config.thresholdKm}km (${origin ?? '?'} -> ${destination ?? '?'})`,
  );
  throw new IntercityRouteError({ distanceKm, durationMin, config });
}

/** Straight-line distance in km (booking-time guard — no routing API cost). */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Structured payload for pricing endpoints when a route is intercity. */
export function intercityResponsePayload(error: IntercityRouteError) {
  return {
    isIntercity: true,
    distanceKm: Math.round(error.distanceKm * 10) / 10,
    durationMin: Math.round(error.durationMin),
    intercity: {
      id: 'intercity',
      name: error.config.name,
      description: error.config.description,
      available: error.config.enabled,
      comingSoon: error.config.comingSoon,
      message: error.config.message,
    },
  };
}
