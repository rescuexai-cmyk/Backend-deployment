/**
 * City name normalization and reverse geocoding for zone/permit rules.
 */

// Maps common alternate / legacy / anglicized names to our canonical zone codes.
const CITY_ALIASES: Record<string, string> = {
  // NCR
  'new delhi': 'delhi',
  'delhi ncr': 'delhi',
  gurugram: 'gurgaon',
  'greater noida': 'noida',
  // Renamed / anglicized city names
  bangalore: 'bengaluru',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  mysore: 'mysuru',
  trivandrum: 'thiruvananthapuram',
  vizag: 'visakhapatnam',
  vishakhapatnam: 'visakhapatnam',
  baroda: 'vadodara',
  cochin: 'kochi',
  pondicherry: 'puducherry',
  gauhati: 'guwahati',
  benares: 'varanasi',
  banaras: 'varanasi',
};

export function normalizeCity(city: string): string {
  const lower = city.toLowerCase().trim();
  return CITY_ALIASES[lower] || lower;
}

const GEOCODE_TIMEOUT_MS = Number(process.env.GEOCODE_TIMEOUT_MS ?? 3000);
const GEOCODE_CACHE_TTL_MS = Number(process.env.GEOCODE_CACHE_TTL_MS ?? 5 * 60 * 1000);
const GEOCODE_CACHE_MAX = 5000;

const geocodeCache = new Map<string, { city: string; expiresAt: number }>();

// ~110m precision — enough to dedupe repeated lookups for the same pickup/drop.
function geocodeCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

/**
 * Reverse geocode coordinates to a normalized city slug using Google Maps API.
 * - Short-lived in-memory cache keyed by rounded coordinates (dedupes hot paths).
 * - Hard request timeout so a slow Google response can't stall booking/pricing.
 * - Falls back to 'delhi' when the API is unavailable or lookup fails.
 */
export async function getCityFromCoordinates(lat: number, lng: number): Promise<string> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return 'delhi';
  }

  const key = geocodeCacheKey(lat, lng);
  const cached = geocodeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.city;
  }

  let city = 'delhi';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&result_type=locality|administrative_area_level_2`;
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();

    if (data.status === 'OK' && data.results?.length > 0) {
      outer: for (const result of data.results) {
        for (const component of result.address_components || []) {
          if (component.types?.includes('locality') || component.types?.includes('administrative_area_level_2')) {
            city = normalizeCity(component.long_name);
            break outer;
          }
        }
      }
    }
  } catch {
    // Fall through to default city.
  } finally {
    clearTimeout(timeout);
  }

  if (geocodeCache.size >= GEOCODE_CACHE_MAX) {
    geocodeCache.clear();
  }
  geocodeCache.set(key, { city, expiresAt: Date.now() + GEOCODE_CACHE_TTL_MS });
  return city;
}
