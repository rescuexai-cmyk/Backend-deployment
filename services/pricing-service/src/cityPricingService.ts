/**
 * City Pricing Service
 * Handles per-city/region pricing lookup with fallback to defaults
 */

import { CityPricingParams } from './algorithms';

// Static fallback city pricing (used if DB not available)
const STATIC_CITY_PRICING: Record<string, Record<string, CityPricingParams>> = {
  delhi: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
  gurgaon: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
  noida: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
  faridabad: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
  ghaziabad: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
};

// City name normalization mapping
const CITY_ALIASES: Record<string, string> = {
  'new delhi': 'delhi',
  'delhi ncr': 'delhi',
  'gurugram': 'gurgaon',
  'greater noida': 'noida',
};

/**
 * Normalize city name for lookup
 */
function normalizeCity(city: string): string {
  const lower = city.toLowerCase().trim();
  return CITY_ALIASES[lower] || lower;
}

/**
 * Reverse geocode coordinates to city name using Google Maps API
 * Falls back to 'delhi' if API unavailable
 */
export async function getCityFromCoordinates(lat: number, lng: number): Promise<string> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.log('[CityPricing] No Google Maps API key, defaulting to delhi');
    return 'delhi';
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${apiKey}&result_type=locality|administrative_area_level_2`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status === 'OK' && data.results?.length > 0) {
      for (const result of data.results) {
        for (const component of result.address_components || []) {
          if (component.types?.includes('locality') || component.types?.includes('administrative_area_level_2')) {
            const city = normalizeCity(component.long_name);
            console.log(`[CityPricing] Detected city: ${city} from coordinates (${lat}, ${lng})`);
            return city;
          }
        }
      }
    }
  } catch (error) {
    console.error('[CityPricing] Reverse geocode failed:', error);
  }

  console.log('[CityPricing] Could not detect city, defaulting to delhi');
  return 'delhi';
}

/**
 * Get city pricing for a vehicle type
 * Returns null if no pricing found (caller should use defaults)
 */
export async function getCityPricing(
  city: string,
  vehicleType: string
): Promise<CityPricingParams | null> {
  const normalizedCity = normalizeCity(city);
  const normalizedVehicle = vehicleType.toLowerCase();

  // Try static pricing first (always available)
  const cityPricing = STATIC_CITY_PRICING[normalizedCity];
  if (cityPricing && cityPricing[normalizedVehicle]) {
    return cityPricing[normalizedVehicle];
  }

  // No pricing found for this city/vehicle combination
  return null;
}

/**
 * Get all vehicle pricing for a city
 */
export async function getAllCityPricing(
  city: string
): Promise<Record<string, CityPricingParams>> {
  const normalizedCity = normalizeCity(city);
  return STATIC_CITY_PRICING[normalizedCity] || STATIC_CITY_PRICING.delhi;
}

/**
 * Get minimum fare for a vehicle type in a city
 */
export async function getMinimumFare(city: string, vehicleType: string): Promise<number> {
  const pricing = await getCityPricing(city, vehicleType);
  return pricing?.minimumFare ?? 35;
}
