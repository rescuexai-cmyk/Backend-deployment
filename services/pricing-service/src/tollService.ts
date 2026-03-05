/**
 * Toll estimation - uses toll plaza data to estimate tolls along route.
 * Major Indian toll plazas with NPCI/NHAI coordinates.
 */

import { createLogger } from '@raahi/shared';

const logger = createLogger('pricing-toll');

// Static fallback: major Indian toll plazas (lat, lng, amount in ₹)
// Sources: NPCI Plaza Master, NHAI, geohacker/toll-plazas-india
const STATIC_TOLL_PLAZAS: Array<{ name: string; lat: number; lng: number; amount: number; highway?: string }> = [
  // Delhi NCR
  { name: 'IGI Toll Plaza', lat: 28.543853, lng: 77.115435, amount: 75, highway: 'NH-48' },
  { name: 'Kherki Daula', lat: 28.395604, lng: 76.981760, amount: 80, highway: 'NH-48' },
  { name: 'Gurugram-Farrukhnagar', lat: 28.365000, lng: 77.050000, amount: 70, highway: 'SH-10' },
  { name: 'Manesar Toll', lat: 28.355000, lng: 76.915000, amount: 75, highway: 'NH-48' },
  { name: 'DND Flyway', lat: 28.582000, lng: 77.332000, amount: 55, highway: 'DND' },
  // Mumbai region
  { name: 'Charoti Toll', lat: 19.890544, lng: 72.942644, amount: 95, highway: 'NH-48' },
  { name: 'Vashi Toll', lat: 19.075000, lng: 72.998000, amount: 60, highway: 'Sion-Panvel' },
  { name: 'Boisar Toll', lat: 19.780000, lng: 72.780000, amount: 75, highway: 'NH-48' },
  { name: 'Mansar Toll', lat: 21.382312, lng: 79.253320, amount: 90, highway: 'NH-44' },
  { name: 'Nagpur Bypass', lat: 20.229935, lng: 79.013193, amount: 85, highway: 'NH-44' },
  // Bangalore / Karnataka
  { name: 'Karjeevanahally', lat: 13.612918, lng: 76.953866, amount: 70, highway: 'NH-48' },
  { name: 'Guilalu Toll', lat: 14.053778, lng: 76.560573, amount: 75, highway: 'NH-48' },
  { name: 'Nelamangala', lat: 13.090000, lng: 77.380000, amount: 65, highway: 'NH-48' },
  { name: 'Hosur Toll', lat: 12.720000, lng: 77.840000, amount: 60, highway: 'NH-44' },
  // Chennai / Tamil Nadu
  { name: 'Sriperumbudur', lat: 12.968000, lng: 79.948000, amount: 55, highway: 'NH-48' },
  { name: 'Gummidipoondi', lat: 13.405000, lng: 80.145000, amount: 65, highway: 'NH-16' },
  // Pune
  { name: 'Shirwal Toll', lat: 18.150000, lng: 73.680000, amount: 95, highway: 'NH-48' },
  { name: 'Talegaon Toll', lat: 18.745000, lng: 73.675000, amount: 75, highway: 'NH-48' },
  // Hyderabad
  { name: 'Shamirpet Toll', lat: 17.445000, lng: 78.568000, amount: 70, highway: 'NH-44' },
  { name: 'Kollur Toll', lat: 17.280000, lng: 78.720000, amount: 65, highway: 'ORR' },
  // Kolkata
  { name: 'Toll near Kolkata', lat: 22.520000, lng: 88.380000, amount: 60, highway: 'NH-16' },
  // Jaipur
  { name: 'Neemrana Toll', lat: 28.365000, lng: 76.380000, amount: 85, highway: 'NH-48' },
  // Ahmedabad
  { name: 'Nadiad Toll', lat: 22.695000, lng: 72.880000, amount: 75, highway: 'NH-48' },
  // Lucknow
  { name: 'Barabanki Toll', lat: 26.925000, lng: 81.195000, amount: 70, highway: 'NH-27' },
  // Kochi
  { name: 'Angamaly Toll', lat: 10.195000, lng: 76.385000, amount: 55, highway: 'NH-544' },
  // Goa
  { name: 'Chorlem Toll', lat: 15.355000, lng: 73.985000, amount: 75, highway: 'NH-66' },
];

const CORRIDOR_KM = 8; // Toll plaza within this km of route considered "on path"
const KM_PER_DEG_LAT = 111;
const KM_PER_DEG_LNG = 85; // approx at ~28°N India

/** Point-to-line distance (km). Line from (lat1,lng1) to (lat2,lng2), point (plat,plng) */
function pointToLineDistanceKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
  plat: number, plng: number
): number {
  const A = plat - lat1;
  const B = plng - lng1;
  const C = lat2 - lat1;
  const D = lng2 - lng1;
  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = lenSq !== 0 ? dot / lenSq : -1;
  if (param < 0) param = 0;
  if (param > 1) param = 1;
  const projLat = lat1 + param * C;
  const projLng = lng1 + param * D;
  const dLat = (plat - projLat) * KM_PER_DEG_LAT;
  const dLng = (plng - projLng) * KM_PER_DEG_LNG;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Check if point is between start and end (projection on segment) */
function isBetweenStartEnd(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
  plat: number, plng: number,
  bufferDeg: number
): boolean {
  const minLat = Math.min(lat1, lat2) - bufferDeg;
  const maxLat = Math.max(lat1, lat2) + bufferDeg;
  const minLng = Math.min(lng1, lng2) - bufferDeg;
  const maxLng = Math.max(lng1, lng2) + bufferDeg;
  return plat >= minLat && plat <= maxLat && plng >= minLng && plng <= maxLng;
}

export async function estimateTollsFromRoute(
  pickupLat: number,
  pickupLng: number,
  dropLat: number,
  dropLng: number
): Promise<{ amount: number; plazas: Array<{ name: string; amount: number }> }> {
  const bufferDeg = CORRIDOR_KM / KM_PER_DEG_LAT;
  const plazas = STATIC_TOLL_PLAZAS.map((p) => ({
    name: p.name,
    lat: p.lat,
    lng: p.lng,
    amount: p.amount,
  }));

  const onRoute: Array<{ name: string; amount: number }> = [];
  let total = 0;

  for (const p of plazas) {
    if (!isBetweenStartEnd(pickupLat, pickupLng, dropLat, dropLng, p.lat, p.lng, bufferDeg)) continue;
    const dist = pointToLineDistanceKm(pickupLat, pickupLng, dropLat, dropLng, p.lat, p.lng);
    if (dist <= CORRIDOR_KM) {
      onRoute.push({ name: p.name, amount: p.amount });
      total += p.amount;
    }
  }

  logger.debug(`[TOLL] Route tolls: ₹${total} from ${onRoute.length} plazas`);

  return { amount: total, plazas: onRoute };
}
