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

import { prisma, createLogger } from '@raahi/shared';

const logger = createLogger('pricing-service:intercity');

export interface IntercityConfig {
  thresholdKm: number;
  /** Once intercity launches, flip to true and stop short-circuiting pricing. */
  enabled: boolean;
  comingSoon: boolean;
  name: string;
  description: string;
  message: string;
}

export const DEFAULT_INTERCITY_CONFIG: IntercityConfig = {
  thresholdKm: 50,
  enabled: false,
  comingSoon: true,
  name: 'Intercity',
  description: 'Outstation trips between cities',
  message: 'Intercity is coming soon',
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

/**
 * Assert a route is NOT an unbookable intercity trip.
 * No-op when intercity is enabled (launched) or under the threshold.
 */
export async function assertNotUnavailableIntercity(
  distanceKm: number,
  durationMin: number,
): Promise<void> {
  const config = await getIntercityConfig();
  if (config.enabled) return;
  if (distanceKm <= config.thresholdKm) return;
  logger.info(
    `[INTERCITY] Route classified intercity: ${distanceKm.toFixed(1)}km > ${config.thresholdKm}km threshold`,
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
