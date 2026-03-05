/**
 * Cab Pricing Algorithms per cab_pricing_algorithms.md
 * Algorithm 1: Base Fare | Algorithm 2: Dynamic Fare | Algorithm 3: Final Fare
 */

export type AlgorithmVehicleType = 'mini' | 'sedan' | 'suv' | 'premium';

export type AppVehicleType =
  | 'bike_rescue'
  | 'auto'
  | 'cab_mini'
  | 'cab_xl'
  | 'cab_premium'
  | 'personal_driver';

// Default fallback parameters when no city pricing is found
const DEFAULT_PARAMS: Record<string, { startingFee: number; ratePerKm: number; ratePerMin: number; minimumFare: number }> = {
  cab_mini: { startingFee: 30, ratePerKm: 12, ratePerMin: 1.5, minimumFare: 35 },
  auto: { startingFee: 25, ratePerKm: 8, ratePerMin: 1.5, minimumFare: 29 },
  cab_xl: { startingFee: 30, ratePerKm: 18, ratePerMin: 2, minimumFare: 49 },
  bike_rescue: { startingFee: 20, ratePerKm: 6, ratePerMin: 1, minimumFare: 19 },
  cab_premium: { startingFee: 50, ratePerKm: 25, ratePerMin: 3, minimumFare: 99 },
  personal_driver: { startingFee: 149, ratePerKm: 0, ratePerMin: 3.5, minimumFare: 149 },
};

// City pricing interface (matches CityPricing model)
export interface CityPricingParams {
  startingFee: number;
  ratePerKm: number;
  ratePerMin: number;
  minimumFare: number;
}

/**
 * Get base fare params - uses city pricing if provided, else defaults
 */
export function getBaseFareParams(
  appVehicleType?: string,
  cityPricing?: CityPricingParams | null
): {
  startingFee: number;
  ratePerKm: number;
  ratePerMin: number;
  minimumFare: number;
  multiplier: number;
  type: string;
} {
  const normalized = (appVehicleType || 'cab_mini').toLowerCase();
  
  // If city pricing is provided, use it
  if (cityPricing) {
    return {
      startingFee: cityPricing.startingFee,
      ratePerKm: cityPricing.ratePerKm,
      ratePerMin: cityPricing.ratePerMin,
      minimumFare: cityPricing.minimumFare,
      multiplier: 1.0,
      type: normalized,
    };
  }
  
  // Fallback to default params
  const p = DEFAULT_PARAMS[normalized] || DEFAULT_PARAMS.cab_mini;
  return { ...p, multiplier: 1.0, type: normalized };
}

/**
 * Algorithm 1: Base Fare = StartingFee + (DistanceKm * RatePerKm) + (TimeMin * RatePerMin) * VehicleMultiplier
 */
export function calculateBaseFare(params: {
  distanceKm: number;
  timeMin: number;
  vehicleType?: string;
  cityPricing?: CityPricingParams | null;
}): {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  minimumFare: number;
  breakdown: { startingFee: number; ratePerKm: number; ratePerMin: number; vehicleMultiplier: number };
} {
  const { distanceKm, timeMin } = params;
  const p = getBaseFareParams(params.vehicleType, params.cityPricing);

  // Edge case: personal_driver ignores distance
  const effectiveDistance = params.vehicleType?.toLowerCase() === 'personal_driver' ? 0 : distanceKm;

  const distanceFare = effectiveDistance * p.ratePerKm;
  const timeFare = timeMin * p.ratePerMin;
  const rawFare = p.startingFee + distanceFare + timeFare;
  let baseFare = rawFare * (p.multiplier !== 1 ? p.multiplier : 1);
  
  // Apply minimum fare floor
  if (baseFare < p.minimumFare) {
    baseFare = p.minimumFare;
  }

  return {
    baseFare: Math.round(baseFare * 100) / 100,
    distanceFare: Math.round(distanceFare * 100) / 100,
    timeFare: Math.round(timeFare * 100) / 100,
    minimumFare: p.minimumFare,
    breakdown: {
      startingFee: p.startingFee,
      ratePerKm: p.ratePerKm,
      ratePerMin: p.ratePerMin,
      vehicleMultiplier: p.multiplier,
    },
  };
}

export type WeatherCondition = 'normal' | 'rain' | 'heavy_rain';

/**
 * Algorithm 2: Dynamic Fare with surge, time, weather, event multipliers (cap 2.0)
 */
export function calculateDynamicFare(params: {
  baseFare: number;
  demandSupplyRatio: number;
  isPeakHour: boolean;
  isNight: boolean;
  isWeekend: boolean;
  weather: WeatherCondition;
  isSpecialEvent: boolean;
}): {
  dynamicFare: number;
  surgeMultiplier: number;
  timeMultiplier: number;
  weatherMultiplier: number;
  eventMultiplier: number;
  totalDynamicMultiplier: number;
} {
  const MAX_MULTIPLIER = 2.0;
  const r = Math.max(0, params.demandSupplyRatio);

  let surgeMultiplier = 1.0;
  if (r < 0.8) surgeMultiplier = 1.0;
  else if (r < 1.2) surgeMultiplier = 1.2;
  else if (r < 1.8) surgeMultiplier = 1.5;
  else if (r < 2.5) surgeMultiplier = 1.8;
  else surgeMultiplier = 2.0;

  let timeMultiplier = 1.0;
  if (params.isPeakHour) timeMultiplier *= 1.15;
  if (params.isNight) timeMultiplier *= 1.25;
  if (params.isWeekend) timeMultiplier *= 1.1;

  let weatherMultiplier = 1.0;
  if (params.weather === 'rain') weatherMultiplier = 1.15;
  if (params.weather === 'heavy_rain') weatherMultiplier = 1.3;

  const eventMultiplier = params.isSpecialEvent ? 1.2 : 1.0;

  let totalMultiplier =
    surgeMultiplier * timeMultiplier * weatherMultiplier * eventMultiplier;
  if (totalMultiplier > MAX_MULTIPLIER) totalMultiplier = MAX_MULTIPLIER;
  if (totalMultiplier < 1.0) totalMultiplier = 1.0;

  const dynamicFare = params.baseFare * totalMultiplier;
  return {
    dynamicFare: Math.round(dynamicFare * 100) / 100,
    surgeMultiplier,
    timeMultiplier,
    weatherMultiplier,
    eventMultiplier,
    totalDynamicMultiplier: totalMultiplier,
  };
}

/**
 * Algorithm 3: Final Fare with tolls, waiting, airport, parking, extra stops, discount, GST
 */
export function calculateFinalFare(params: {
  dynamicFare: number;
  tolls?: number;
  waitingMinutes?: number;
  hasAirportPickup?: boolean;
  parkingFees?: number;
  extraStopsCount?: number;
  discountPercent?: number;
  discountAmount?: number; // Flat discount amount (from promo)
  minimumFare?: number; // Per-vehicle minimum fare
}): {
  finalFare: number;
  breakdown: {
    dynamicFare: number;
    tolls: number;
    waitingCharge: number;
    airportCharge: number;
    parkingFees: number;
    extraStopsCharge: number;
    subtotal: number;
    discount: number;
    afterDiscount: number;
    gstPercent: number;
    gstAmount: number;
    minimumFareApplied: boolean;
  };
} {
  const FREE_WAITING_MIN = 3;
  const WAITING_RATE_PER_MIN = 2;
  const AIRPORT_PICKUP_FEE = 50;
  const EXTRA_STOP_FEE = 10;
  const DEFAULT_MINIMUM_FARE = 35;
  const GST_RATE = 0.05;

  const minimumFare = params.minimumFare ?? DEFAULT_MINIMUM_FARE;
  const tolls = Math.max(0, params.tolls ?? 0);
  const waitingMinutes = Math.max(0, params.waitingMinutes ?? 0);
  const parkingFees = Math.max(0, params.parkingFees ?? 0);
  let discountPercent = params.discountPercent ?? 0;
  if (discountPercent < 0) discountPercent = 0;
  if (discountPercent > 100) discountPercent = 100;
  const discountAmount = Math.max(0, params.discountAmount ?? 0);
  const extraStopsCount = Math.max(0, params.extraStopsCount ?? 0);
  const hasAirportPickup = params.hasAirportPickup ?? false;

  const chargeableWaitingMin = Math.max(0, waitingMinutes - FREE_WAITING_MIN);
  const waitingCharge = chargeableWaitingMin * WAITING_RATE_PER_MIN;
  const airportCharge = hasAirportPickup ? AIRPORT_PICKUP_FEE : 0;
  const stopsCharge = extraStopsCount * EXTRA_STOP_FEE;

  const additionalCharges = tolls + waitingCharge + airportCharge + parkingFees + stopsCharge;
  let subtotal = params.dynamicFare + additionalCharges;
  
  // Apply minimum fare floor
  let minimumFareApplied = false;
  if (subtotal < minimumFare) {
    subtotal = minimumFare;
    minimumFareApplied = true;
  }

  // Calculate discount: prefer flat amount, else use percent
  let discount = 0;
  if (discountAmount > 0) {
    discount = discountAmount;
  } else if (discountPercent > 0) {
    discount = (subtotal * discountPercent) / 100;
  }
  
  const afterDiscount = Math.max(0, subtotal - discount);
  const gstAmount = afterDiscount * GST_RATE;
  const finalFare = Math.round(afterDiscount * (1 + GST_RATE));

  return {
    finalFare,
    breakdown: {
      dynamicFare: params.dynamicFare,
      tolls,
      waitingCharge,
      airportCharge,
      parkingFees,
      extraStopsCharge: stopsCharge,
      subtotal,
      discount,
      afterDiscount,
      gstPercent: 5,
      gstAmount,
      minimumFareApplied,
    },
  };
}
