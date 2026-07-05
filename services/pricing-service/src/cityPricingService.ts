/**
 * City Pricing Service
 * Handles per-city/region pricing lookup with fallback to defaults
 */

import { CityPricingParams } from './algorithms';
import { normalizeCity, getCityFromCoordinates } from '@raahi/shared';

export { getCityFromCoordinates, normalizeCity };

// Static fallback city pricing (used if DB not available)
const STATIC_CITY_PRICING: Record<string, Record<string, CityPricingParams>> = {
  delhi: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_taxi: { startingFee: 15, ratePerKm: 5, ratePerMin: 0.8, minimumFare: 15 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
  gurgaon: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_taxi: { startingFee: 15, ratePerKm: 5, ratePerMin: 0.8, minimumFare: 15 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
  noida: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_taxi: { startingFee: 15, ratePerKm: 5, ratePerMin: 0.8, minimumFare: 15 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
  faridabad: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_taxi: { startingFee: 15, ratePerKm: 5, ratePerMin: 0.8, minimumFare: 15 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
  ghaziabad: {
    cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
    auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
    cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
    bike_taxi: { startingFee: 15, ratePerKm: 5, ratePerMin: 0.8, minimumFare: 15 },
    bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
    cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
    personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
  },
};

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
