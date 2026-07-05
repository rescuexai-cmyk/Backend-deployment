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
  'gautam buddha nagar': 'noida',
  'gautam buddh nagar': 'noida',
  'gb nagar': 'noida',
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

/** Operational zone bounding boxes for NCR — used when H3 cells aren't seeded or geocoding mislabels an endpoint. */
const OPERATIONAL_ZONE_BBOXES: Array<{
  zone: string;
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}> = [
  // Faridabad (Haryana) — sits west of the Yamuna river (~lng 77.38). Checked
  // BEFORE Noida so the overlapping strip is never misclassified as Noida (UP),
  // which previously made Gurgaon→Faridabad look like a Haryana→UP border trip.
  { zone: 'faridabad', minLat: 28.25, maxLat: 28.48, minLng: 77.2, maxLng: 77.38 },
  // Noida + Greater Noida (Gautam Buddha Nagar, UP) — same operational zone.
  // Split at the Yamuna: Noida proper is north of lat ~28.46; the southern
  // strip (Greater Noida / Yamuna Expressway) lies east of lng ~77.38.
  { zone: 'noida', minLat: 28.46, maxLat: 28.65, minLng: 77.29, maxLng: 77.65 },
  { zone: 'noida', minLat: 28.3, maxLat: 28.46, minLng: 77.38, maxLng: 77.65 },
  { zone: 'ghaziabad', minLat: 28.55, maxLat: 28.78, minLng: 77.25, maxLng: 77.55 },
  { zone: 'gurgaon', minLat: 28.25, maxLat: 28.55, minLng: 76.82, maxLng: 77.15 },
];

function isInsideBbox(
  lat: number,
  lng: number,
  box: (typeof OPERATIONAL_ZONE_BBOXES)[number],
): boolean {
  return lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng;
}

/**
 * Resolve operational zone from coordinates using known NCR bounding boxes.
 * Returns null when the point is outside all known boxes.
 */
export function getOperationalZoneFromCoordinates(lat: number, lng: number): string | null {
  for (const box of OPERATIONAL_ZONE_BBOXES) {
    if (isInsideBbox(lat, lng, box)) {
      return box.zone;
    }
  }
  return null;
}

/** True when pickup and drop fall in the same operational zone bbox (e.g. Noida ↔ Greater Noida). */
export function areCoordinatesInSameOperationalZone(
  pickupLat: number,
  pickupLng: number,
  dropLat: number,
  dropLng: number,
): boolean {
  const pickupZone = getOperationalZoneFromCoordinates(pickupLat, pickupLng);
  const dropZone = getOperationalZoneFromCoordinates(dropLat, dropLng);
  return pickupZone !== null && pickupZone === dropZone;
}

// ~110m precision — enough to dedupe repeated lookups for the same pickup/drop.
function geocodeCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

function cityFromGeocodeComponents(components: Array<{ long_name?: string; types?: string[] }>): string | null {
  let state: string | null = null;
  let district: string | null = null;
  let locality: string | null = null;

  for (const component of components) {
    const types = component.types ?? [];
    const name = component.long_name ?? '';
    if (types.includes('administrative_area_level_1')) {
      state = name.toLowerCase();
    } else if (types.includes('administrative_area_level_2')) {
      district = normalizeCity(name);
    } else if (types.includes('locality')) {
      locality = normalizeCity(name);
    }
  }

  // Gautam Buddha Nagar (UP) covers Noida and Greater Noida — always map to noida.
  if (district === 'noida' || district === 'gautam buddha nagar' || district === 'gautam buddh nagar') {
    return 'noida';
  }
  if (locality === 'noida') {
    return 'noida';
  }
  if (locality) {
    return locality;
  }
  if (district) {
    return district;
  }
  // Avoid misclassifying UP addresses near the Delhi border as Delhi when state is UP.
  if (state?.includes('uttar pradesh')) {
    return 'noida';
  }
  return null;
}

/**
 * Reverse geocode coordinates to a normalized city slug using Google Maps API.
 * - Short-lived in-memory cache keyed by rounded coordinates (dedupes hot paths).
 * - Hard request timeout so a slow Google response can't stall booking/pricing.
 * - Uses coordinate bounding boxes before geocoding (Noida ↔ Greater Noida).
 * - Falls back to 'delhi' only when no bbox or geocode match is found.
 */
export async function getCityFromCoordinates(lat: number, lng: number): Promise<string> {
  const bboxZone = getOperationalZoneFromCoordinates(lat, lng);
  if (bboxZone) {
    return bboxZone;
  }

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
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}`;
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();

    if (data.status === 'OK' && data.results?.length > 0) {
      for (const result of data.results) {
        const resolved = cityFromGeocodeComponents(result.address_components || []);
        if (resolved) {
          city = resolved;
          break;
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
