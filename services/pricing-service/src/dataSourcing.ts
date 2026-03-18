/**
 * Data sourcing for dynamic pricing inputs per cab_pricing_algorithms.md
 */

import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import type { WeatherCondition } from './algorithms';
import { computeZoneHealthScore } from './marketplacePolicy';

const logger = createLogger('pricing-data');

// Time config (India timezone UTC+5:30)
const PEAK_HOURS = [
  [8, 10],   // 08:00-10:00
  [17, 20],  // 17:00-20:00
];
const NIGHT_START = 22; // 22:00
const NIGHT_END = 5;    // 05:00

export function getTimeBasedFlags(date: Date): {
  isPeakHour: boolean;
  isNight: boolean;
  isWeekend: boolean;
} {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + d.getTimezoneOffset() + 330); // IST
  const hour = d.getHours();
  const day = d.getDay(); // 0 = Sunday, 6 = Saturday

  let isPeakHour = false;
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) {
      isPeakHour = true;
      break;
    }
  }

  const isNight = hour >= NIGHT_START || hour < NIGHT_END;
  const isWeekend = day === 0 || day === 6;

  return { isPeakHour, isNight, isWeekend };
}

// EMA (Exponential Moving Average) cache for demand/supply smoothing
// Key: H3 cell or lat/lng grid, Value: { ema, lastUpdated }
const demandEmaCache = new Map<string, { ema: number; lastUpdated: number }>();
const EMA_ALPHA = 0.3; // Smoothing factor (0.3 = 30% weight to new value, 70% to old)
const DEMAND_WINDOW_MIN = 5; // Shortened from 15 to 5 minutes for more real-time data

function calculateEma(newValue: number, oldEma: number | undefined): number {
  if (oldEma === undefined) return newValue;
  return EMA_ALPHA * newValue + (1 - EMA_ALPHA) * oldEma;
}

function getDemandCacheKey(lat: number, lng: number): string {
  // Grid key at ~1km resolution
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

export async function getDemandSupplyRatio(
  lat: number,
  lng: number,
  radiusKm: number = 5
): Promise<number> {
  const cacheKey = getDemandCacheKey(lat, lng);
  
  try {
    const delta = 0.045 * radiusKm; // ~5km per 0.045 deg
    const latMin = lat - delta;
    const latMax = lat + delta;
    const lngMin = lng - delta;
    const lngMax = lng + delta;

    // Shortened time window from 15 min to 5 min for more real-time data
    const [pendingRides, onlineDrivers] = await Promise.all([
      prisma.ride.count({
        where: {
          status: 'PENDING',
          pickupLatitude: { gte: latMin, lte: latMax },
          pickupLongitude: { gte: lngMin, lte: lngMax },
          createdAt: { gte: new Date(Date.now() - DEMAND_WINDOW_MIN * 60 * 1000) },
        },
      }),
      prisma.driver.count({
        where: {
          isOnline: true,
          isActive: true,
          currentLatitude: { gte: latMin, lte: latMax },
          currentLongitude: { gte: lngMin, lte: lngMax },
        },
      }),
    ]);

    // Calculate raw ratio
    const rawRatio = onlineDrivers > 0 ? pendingRides / onlineDrivers : 1.0;
    const cappedRatio = Math.min(rawRatio, 3);
    
    // Apply EMA smoothing to avoid sudden surge spikes
    const cached = demandEmaCache.get(cacheKey);
    const smoothedRatio = calculateEma(cappedRatio, cached?.ema);
    
    // Update cache
    demandEmaCache.set(cacheKey, { ema: smoothedRatio, lastUpdated: Date.now() });
    
    logger.debug(`[DATA] Demand/supply: raw=${rawRatio.toFixed(2)}, smoothed=${smoothedRatio.toFixed(2)} (pending=${pendingRides}, drivers=${onlineDrivers})`);
    
    return smoothedRatio;
  } catch (e) {
    logger.warn('[DATA] Demand/supply query failed, defaulting to 1.0', { error: (e as Error).message });
    return 1.0;
  }
}

/**
 * Clear old EMA cache entries (call periodically)
 */
export function cleanupDemandCache(): void {
  const maxAge = 30 * 60 * 1000; // 30 minutes
  const now = Date.now();
  for (const [key, value] of demandEmaCache.entries()) {
    if (now - value.lastUpdated > maxAge) {
      demandEmaCache.delete(key);
    }
  }
}

// Simple in-memory cache for weather (15 min TTL)
const weatherCache = new Map<string, { value: WeatherCondition; expires: number }>();
const CACHE_TTL_MS = 15 * 60 * 1000;

export async function getWeatherCondition(lat: number, lng: number): Promise<WeatherCondition> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = weatherCache.get(key);
  if (cached && Date.now() < cached.expires) return cached.value;

  const apiKey = process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) return 'normal';

  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${apiKey}&units=metric`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.weather?.[0]) {
      const main = (data.weather[0].main || '').toLowerCase();
      const desc = (data.weather[0].description || '').toLowerCase();
      let value: WeatherCondition = 'normal';
      if (main.includes('rain') || desc.includes('rain')) {
        value = desc.includes('heavy') || data.rain?.['1h'] > 10 ? 'heavy_rain' : 'rain';
      }
      weatherCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
      return value;
    }
  } catch (e) {
    logger.debug('[DATA] Weather API failed', { error: (e as Error).message });
  }
  return 'normal';
}

// Major Indian airport bounds (simplified rectangles) - expanded list
const AIRPORTS = [
  // Metro
  { name: 'Delhi IGI', lat: [28.54, 28.58], lng: [77.06, 77.18] },
  { name: 'Mumbai', lat: [19.07, 19.12], lng: [72.84, 72.92] },
  { name: 'Bangalore', lat: [12.93, 12.97], lng: [77.64, 77.72] },
  { name: 'Hyderabad', lat: [17.21, 17.27], lng: [78.40, 78.48] },
  { name: 'Chennai', lat: [12.97, 13.01], lng: [80.14, 80.20] },
  { name: 'Kolkata', lat: [22.62, 22.68], lng: [88.40, 88.48] },
  // Tier-2
  { name: 'Pune', lat: [18.57, 18.59], lng: [73.91, 73.93] },
  { name: 'Ahmedabad', lat: [23.06, 23.08], lng: [72.63, 72.67] },
  { name: 'Jaipur', lat: [26.88, 26.92], lng: [75.78, 75.84] },
  { name: 'Lucknow', lat: [26.75, 26.79], lng: [80.88, 80.92] },
  { name: 'Kochi', lat: [10.15, 10.17], lng: [76.38, 76.42] },
  { name: 'Goa', lat: [15.37, 15.39], lng: [73.82, 73.86] },
  { name: 'Thiruvananthapuram', lat: [8.48, 8.52], lng: [76.91, 76.95] },
  { name: 'Coimbatore', lat: [11.02, 11.04], lng: [77.03, 77.07] },
  { name: 'Mangalore', lat: [12.95, 12.97], lng: [74.88, 74.92] },
  { name: 'Chandigarh', lat: [30.66, 30.70], lng: [76.78, 76.82] },
  { name: 'Srinagar', lat: [33.99, 34.01], lng: [74.77, 74.81] },
  { name: 'Guwahati', lat: [26.09, 26.11], lng: [91.58, 91.62] },
  { name: 'Bhubaneswar', lat: [20.24, 20.26], lng: [85.81, 85.85] },
  { name: 'Nagpur', lat: [21.09, 21.11], lng: [79.04, 79.08] },
  { name: 'Indore', lat: [22.71, 22.73], lng: [75.80, 75.84] },
  { name: 'Vadodara', lat: [22.31, 22.33], lng: [73.22, 73.26] },
  { name: 'Dehradun', lat: [30.18, 30.22], lng: [78.18, 78.22] },
];

export function isAirportPickup(lat: number, lng: number): boolean {
  for (const a of AIRPORTS) {
    if (
      lat >= a.lat[0] && lat <= a.lat[1] &&
      lng >= a.lng[0] && lng <= a.lng[1]
    ) {
      return true;
    }
  }
  return false;
}

export async function isSpecialEventActive(): Promise<boolean> {
  try {
    const config = await prisma.platformConfig.findUnique({
      where: { key: 'special_event_active' },
    });
    if (config?.value === 'true' || config?.value === '1') return true;
  } catch {
    // ignore
  }
  return false;
}

function getPercentile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface ZoneRealtimeSnapshot {
  fulfillment: number;
  acceptRate: number;
  etaP90: number;
  supplyRate: number;
  zoneHealth: number;
  totalRequests: number;
  onlineDrivers: number;
}

/**
 * Real-time liquidity health snapshot for marketplace controls.
 * Kept intentionally lightweight so it can run per pricing call.
 */
export async function getZoneRealtimeSnapshot(
  lat: number,
  lng: number,
  cityCode: string,
  radiusKm: number = 5
): Promise<ZoneRealtimeSnapshot> {
  const delta = 0.045 * radiusKm;
  const latMin = lat - delta;
  const latMax = lat + delta;
  const lngMin = lng - delta;
  const lngMax = lng + delta;
  const lookback = new Date(Date.now() - 60 * 60 * 1000);

  const [rides, onlineDrivers] = await Promise.all([
    prisma.ride.findMany({
      where: {
        pickupLatitude: { gte: latMin, lte: latMax },
        pickupLongitude: { gte: lngMin, lte: lngMax },
        createdAt: { gte: lookback },
      },
      select: {
        id: true,
        status: true,
        createdAt: true,
        driverAssignedAt: true,
      },
      take: 500,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.driver.count({
      where: {
        isOnline: true,
        isActive: true,
        currentLatitude: { gte: latMin, lte: latMax },
        currentLongitude: { gte: lngMin, lte: lngMax },
      },
    }),
  ]);

  const totalRequests = rides.length;
  const completed = rides.filter((r) => r.status === 'RIDE_COMPLETED').length;
  const accepted = rides.filter((r) => r.driverAssignedAt != null).length;
  const fulfillment = totalRequests > 0 ? completed / totalRequests : 1;
  const acceptRate = totalRequests > 0 ? accepted / totalRequests : 1;
  const etaSamples = rides
    .filter((r) => r.driverAssignedAt != null)
    .map((r) => (r.driverAssignedAt!.getTime() - r.createdAt.getTime()) / (1000 * 60))
    .filter((m) => Number.isFinite(m) && m >= 0);
  const etaP90 = getPercentile(etaSamples, 90);
  const supplyRate = onlineDrivers / Math.max(1, totalRequests);
  const zoneHealth = computeZoneHealthScore({ fulfillment, acceptRate, etaP90 });

  // Opportunistically persist latest zone score (upsert by zone_id + city).
  const zoneId = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const db = prisma as any;
  await db.pricingZoneHealth?.upsert({
    where: { zoneId_cityCode: { zoneId, cityCode } },
    update: {
      fulfillment,
      etaP90,
      acceptRate,
      healthScore: zoneHealth,
      observedAt: new Date(),
    },
    create: {
      zoneId,
      cityCode,
      fulfillment,
      etaP90,
      acceptRate,
      healthScore: zoneHealth,
    },
  }).catch(() => {
    // Keep pricing path resilient if persistence fails.
  });

  return {
    fulfillment,
    acceptRate,
    etaP90,
    supplyRate,
    zoneHealth,
    totalRequests,
    onlineDrivers,
  };
}
