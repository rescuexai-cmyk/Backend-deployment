/**
 * Route service: get distance (km) and duration (min) between pickup and drop.
 * Uses Google Maps Directions API with traffic awareness if key available,
 * else geolib haversine + estimated duration with peak hour buffer.
 */

import { getDistance } from 'geolib';
import { createLogger } from '@raahi/shared';

const logger = createLogger('pricing-route');

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

export interface RouteResult {
  distanceKm: number;
  timeMin: number;
  trafficTimeMin?: number; // duration_in_traffic if available
  source: 'google_maps_traffic' | 'google_maps' | 'haversine';
}

function haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return getDistance(
    { latitude: lat1, longitude: lng1 },
    { latitude: lat2, longitude: lng2 }
  ) / 1000;
}

function isPeakHour(date: Date): boolean {
  const hour = date.getHours();
  return (hour >= 8 && hour <= 10) || (hour >= 17 && hour <= 20);
}

function estimateDurationMin(distanceKm: number, applyPeakBuffer: boolean): number {
  // ~25 km/h average city speed
  let baseMin = Math.ceil((distanceKm / 25) * 60);
  // Apply +20% buffer during peak hours when no traffic data
  if (applyPeakBuffer) {
    baseMin = Math.ceil(baseMin * 1.2);
  }
  return baseMin;
}

export async function getRouteDistanceAndTime(
  pickupLat: number,
  pickupLng: number,
  dropLat: number,
  dropLng: number,
  departureTime?: Date
): Promise<RouteResult> {
  const now = departureTime || new Date();
  const isPeak = isPeakHour(now);

  if (GOOGLE_MAPS_API_KEY) {
    try {
      const origin = `${pickupLat},${pickupLng}`;
      const dest = `${dropLat},${dropLng}`;
      // Add departure_time=now for traffic-aware routing
      const departureTimestamp = Math.floor(now.getTime() / 1000);
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${dest}&key=${GOOGLE_MAPS_API_KEY}&mode=driving&departure_time=${departureTimestamp}`;
      
      const res = await fetch(url);
      const data = await res.json();
      
      if (data.status === 'OK' && data.routes?.[0]) {
        const leg = data.routes[0].legs[0];
        const distanceM = leg.distance?.value ?? 0;
        const distanceKm = distanceM / 1000;
        
        // Prefer duration_in_traffic if available (requires departure_time)
        const trafficDurationS = leg.duration_in_traffic?.value;
        const baseDurationS = leg.duration?.value ?? 0;
        
        if (trafficDurationS) {
          const trafficTimeMin = Math.ceil(trafficDurationS / 60);
          const baseTimeMin = Math.ceil(baseDurationS / 60);
          logger.debug(`[ROUTE] Google Maps (traffic): ${distanceKm.toFixed(2)} km, ${trafficTimeMin} min (base: ${baseTimeMin} min)`);
          return { 
            distanceKm, 
            timeMin: trafficTimeMin, 
            trafficTimeMin,
            source: 'google_maps_traffic' 
          };
        }
        
        // Fallback to base duration if traffic data unavailable
        const timeMin = Math.ceil(baseDurationS / 60);
        // Apply peak buffer if no traffic data but during peak hours
        const adjustedTimeMin = isPeak ? Math.ceil(timeMin * 1.2) : timeMin;
        logger.debug(`[ROUTE] Google Maps (no traffic): ${distanceKm.toFixed(2)} km, ${adjustedTimeMin} min${isPeak ? ' (peak buffer applied)' : ''}`);
        return { distanceKm, timeMin: adjustedTimeMin, source: 'google_maps' };
      }
    } catch (e) {
      logger.warn('[ROUTE] Google Maps API failed, using haversine fallback', { error: (e as Error).message });
    }
  }

  const distanceKm = haversineDistanceKm(pickupLat, pickupLng, dropLat, dropLng);
  const timeMin = estimateDurationMin(distanceKm, isPeak);
  logger.debug(`[ROUTE] Haversine fallback: ${distanceKm.toFixed(2)} km, ${timeMin} min${isPeak ? ' (peak buffer applied)' : ''}`);
  return { distanceKm, timeMin, source: 'haversine' };
}
