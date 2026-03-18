/**
 * Pricing Service - Implements cab_pricing_algorithms.md
 * Estimate: Algorithm 1 + 2 | Finalize: Algorithm 3
 */

import { getDistance } from 'geolib';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import {
  latLngToH3,
  getKRing,
  getH3Config,
  createMatchingLog,
  logMatchingProcess,
  estimateKRingRadiusKm,
} from '@raahi/shared';
import {
  calculateBaseFare,
  calculateDynamicFare,
  calculateFinalFare,
  CityPricingParams,
} from './algorithms';
import { getRouteDistanceAndTime } from './routeService';
import {
  getTimeBasedFlags,
  getDemandSupplyRatio,
  getWeatherCondition,
  isAirportPickup,
  isSpecialEventActive,
  getZoneRealtimeSnapshot,
} from './dataSourcing';
import { estimateTollsFromRoute } from './tollService';
import { getCityFromCoordinates, getCityPricing, getMinimumFare } from './cityPricingService';
import {
  applyPricingPolicyV2,
  getCurrentBurnRate,
  getMarketplacePolicy,
  MarketplaceMode,
  recordBurnMetricDelta,
} from './marketplacePolicy';

const logger = createLogger('pricing-service');

// ============================================================
// Request / Response types
// ============================================================

export interface PricingRequest {
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  vehicleType?: string;
  scheduledTime?: Date;
}

export interface EstimateResponse {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeMultiplier: number;
  totalFare: number;
  minimumFare: number;
  distance: number;
  distanceKm: number;
  estimatedDuration: number;
  estimatedDurationMin: number;
  vehicleType: string;
  city: string;
  breakdown: {
    startingFee: number;
    ratePerKm: number;
    ratePerMin: number;
    vehicleMultiplier: number;
    dynamicMultiplier: number;
  };
  marketplace?: {
    mode: MarketplaceMode;
    riderFinalFare: number;
    subsidyAmount: number;
    driverBoostAmount: number;
    questIncentiveAmount: number;
    burnRate: number;
    contribution: number;
    zoneHealth: number;
    supplyRate: number;
    etaP90: number;
    liquidityActions: string[];
    effectiveSubsidyPct: number;
    guarantee: {
      enabled: boolean;
      hourlyAmount: number;
    };
    driverTripFloor: number;
    questPlan: {
      milestones: Array<{ rides: number; payout: number }>;
      perRidePeakBonus: number;
    };
  };
}

export interface FinalizeRequest {
  rideId: string;
  dynamicFare: number;
  vehicleType?: string;
  city?: string;
  pickupLat?: number;
  pickupLng?: number;
  dropLat?: number;
  dropLng?: number;
  tolls?: number;
  waitingMinutes?: number;
  hasAirportPickup?: boolean;
  parkingFees?: number;
  extraStopsCount?: number;
  discountPercent?: number;
  discountAmount?: number; // Flat discount from promo
}

export interface FinalizeResponse {
  finalFare: number;
  breakdown: Record<string, number>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ============================================================
// Estimate: Algorithm 1 + 2
// ============================================================

export async function calculateFare(request: PricingRequest): Promise<EstimateResponse> {
  const { pickupLat, pickupLng, dropLat, dropLng, vehicleType, scheduledTime } = request;

  // Edge case: validate inputs
  if (
    !Number.isFinite(pickupLat) || !Number.isFinite(pickupLng) ||
    !Number.isFinite(dropLat) || !Number.isFinite(dropLng)
  ) {
    throw new Error('Invalid coordinates');
  }

  const vehicle = (vehicleType || 'cab_mini').toLowerCase();
  const date = scheduledTime ? new Date(scheduledTime) : new Date();

  // Get city from pickup coordinates for per-city pricing
  const city = await getCityFromCoordinates(pickupLat, pickupLng);
  const cityPricing = await getCityPricing(city, vehicle);

  const route = await getRouteDistanceAndTime(pickupLat, pickupLng, dropLat, dropLng, date);
  let { distanceKm, timeMin } = route;

  if (distanceKm < 0 || !Number.isFinite(distanceKm)) distanceKm = 0;
  if (timeMin < 0 || !Number.isFinite(timeMin)) timeMin = 0;

  if (distanceKm === 0 && timeMin === 0) {
    logger.warn('[PRICING] Route not found (0 distance/time), using minimum');
    distanceKm = 0.1;
    timeMin = 1;
  }

  const [demandSupplyRatio, weather, isSpecialEvent] = await Promise.all([
    getDemandSupplyRatio(pickupLat, pickupLng, 5),
    getWeatherCondition(pickupLat, pickupLng),
    isSpecialEventActive(),
  ]);
  const [policy, burnRate, zoneSnapshot] = await Promise.all([
    getMarketplacePolicy(city),
    getCurrentBurnRate(city),
    getZoneRealtimeSnapshot(pickupLat, pickupLng, city, 5),
  ]);

  const { isPeakHour, isNight, isWeekend } = getTimeBasedFlags(date);

  // Pass city pricing to base fare calculation
  const base = calculateBaseFare({ distanceKm, timeMin, vehicleType: vehicle, cityPricing });
  const v2Pre = applyPricingPolicyV2({
    vehicleType: vehicle,
    riderFinalFare: base.baseFare,
    policy,
    burnRate,
    zone: {
      fulfillment: zoneSnapshot.fulfillment,
      acceptRate: zoneSnapshot.acceptRate,
      etaP90: zoneSnapshot.etaP90,
      supplyRate: zoneSnapshot.supplyRate,
      zoneHealth: zoneSnapshot.zoneHealth,
    },
    platformFeeRate: 0.2,
    isPeakHour,
  });
  const dynamic = calculateDynamicFare({
    baseFare: base.baseFare,
    demandSupplyRatio: demandSupplyRatio * v2Pre.surgeSensitivity,
    isPeakHour,
    isNight,
    isWeekend,
    weather,
    isSpecialEvent,
  });

  // Use per-vehicle minimum fare
  const riderFinalFare = Math.max(base.minimumFare, round2(dynamic.dynamicFare));
  const v2 = applyPricingPolicyV2({
    vehicleType: vehicle,
    riderFinalFare,
    policy,
    burnRate,
    zone: {
      fulfillment: zoneSnapshot.fulfillment,
      acceptRate: zoneSnapshot.acceptRate,
      etaP90: zoneSnapshot.etaP90,
      supplyRate: zoneSnapshot.supplyRate,
      zoneHealth: zoneSnapshot.zoneHealth,
    },
    platformFeeRate: 0.2,
    isPeakHour,
  });
  const totalFare = Math.max(base.minimumFare, v2.riderFare);

  // Track burn on quoted demand (approximate but real-time for guardrails).
  await recordBurnMetricDelta({
    cityCode: city,
    gmvDelta: totalFare,
    subsidyDelta: v2.riderSubsidy,
    incentivesDelta: v2.driverBoost + v2.questIncentive,
  }).catch(() => {
    // Keep quote path resilient even if metrics write fails.
  });

  logger.info(
    `[PRICING] ${city}/${vehicle} | ${round2(distanceKm)}km | ${timeMin}min | base=₹${base.baseFare} | surge=${dynamic.surgeMultiplier}x | total=₹${totalFare}`
  );

  const dist = round2(distanceKm);
  return {
    baseFare: round2(base.baseFare),
    distanceFare: base.distanceFare,
    timeFare: base.timeFare,
    surgeMultiplier: dynamic.surgeMultiplier,
    totalFare,
    minimumFare: base.minimumFare,
    distance: dist,
    distanceKm: dist,
    estimatedDuration: timeMin,
    estimatedDurationMin: timeMin,
    vehicleType: vehicle,
    city,
    breakdown: {
      startingFee: base.breakdown.startingFee,
      ratePerKm: base.breakdown.ratePerKm,
      ratePerMin: base.breakdown.ratePerMin,
      vehicleMultiplier: base.breakdown.vehicleMultiplier,
      dynamicMultiplier: dynamic.totalDynamicMultiplier,
    },
    marketplace: {
      mode: policy.marketplaceMode,
      riderFinalFare,
      subsidyAmount: v2.riderSubsidy,
      driverBoostAmount: v2.driverBoost,
      questIncentiveAmount: v2.questIncentive,
      burnRate: v2.burnRate,
      contribution: v2.contribution,
      zoneHealth: zoneSnapshot.zoneHealth,
      supplyRate: round2(zoneSnapshot.supplyRate),
      etaP90: round2(zoneSnapshot.etaP90),
      liquidityActions: v2.liquidityActions,
      effectiveSubsidyPct: v2.effectiveSubsidyPct,
      guarantee: v2.guarantee,
      driverTripFloor: v2.driverTripFloor,
      questPlan: v2.questPlan,
    },
  };
}

// ============================================================
// Calculate all vehicle types (for frontend cab picker)
// ============================================================

const ALL_VEHICLE_TYPES = [
  'bike_rescue',
  'auto',
  'cab_mini',
  'cab_xl',
  'cab_premium',
  'personal_driver',
];

export async function calculateAllFares(
  pickupLat: number,
  pickupLng: number,
  dropLat: number,
  dropLng: number,
  scheduledTime?: Date
): Promise<Record<string, EstimateResponse>> {
  const results: Record<string, EstimateResponse> = {};
  for (const vt of ALL_VEHICLE_TYPES) {
    results[vt] = await calculateFare({
      pickupLat,
      pickupLng,
      dropLat,
      dropLng,
      vehicleType: vt,
      scheduledTime,
    });
  }

  // Cheapest visible option: eco_pickup (virtual category, 10-18% lower).
  const cheapest = Object.values(results).sort((a, b) => a.totalFare - b.totalFare)[0];
  if (cheapest) {
    const ecoDiscountPct = 0.12;
    const ecoFare = round2(Math.max(cheapest.minimumFare, cheapest.totalFare * (1 - ecoDiscountPct)));
    results.eco_pickup = {
      ...cheapest,
      vehicleType: 'eco_pickup',
      totalFare: ecoFare,
      marketplace: cheapest.marketplace
        ? {
            ...cheapest.marketplace,
            riderFinalFare: cheapest.marketplace.riderFinalFare,
            subsidyAmount: round2(
              cheapest.marketplace.subsidyAmount + (cheapest.totalFare - ecoFare)
            ),
            liquidityActions: [
              ...cheapest.marketplace.liquidityActions,
              'eco_pickup_applied',
            ],
          }
        : undefined,
    };
  }
  return results;
}

// ============================================================
// Finalize: Algorithm 3 (post-ride)
// ============================================================

export async function finalizeFare(request: FinalizeRequest): Promise<FinalizeResponse> {
  let hasAirportPickup = request.hasAirportPickup ?? false;
  if (
    hasAirportPickup === false &&
    Number.isFinite(request.pickupLat) &&
    Number.isFinite(request.pickupLng)
  ) {
    hasAirportPickup = isAirportPickup(request.pickupLat!, request.pickupLng!);
  }

  // Use driver input for tolls, or estimate from route (pickup→drop) if not provided
  let tolls = request.tolls ?? 0;
  if (
    tolls === 0 &&
    Number.isFinite(request.pickupLat) &&
    Number.isFinite(request.pickupLng) &&
    Number.isFinite(request.dropLat) &&
    Number.isFinite(request.dropLng)
  ) {
    const est = await estimateTollsFromRoute(
      request.pickupLat!,
      request.pickupLng!,
      request.dropLat!,
      request.dropLng!
    );
    tolls = est.amount;
    if (tolls > 0) {
      logger.info(`[PRICING] Estimated tolls ₹${tolls} from ${est.plazas.length} plazas`);
    }
  }

  // Get per-vehicle minimum fare for the city
  let minimumFare = 35;
  if (request.city && request.vehicleType) {
    minimumFare = await getMinimumFare(request.city, request.vehicleType);
  } else if (Number.isFinite(request.pickupLat) && Number.isFinite(request.pickupLng) && request.vehicleType) {
    const city = await getCityFromCoordinates(request.pickupLat!, request.pickupLng!);
    minimumFare = await getMinimumFare(city, request.vehicleType);
  }

  const result = calculateFinalFare({
    dynamicFare: request.dynamicFare,
    tolls,
    waitingMinutes: request.waitingMinutes ?? 0,
    hasAirportPickup,
    parkingFees: request.parkingFees ?? 0,
    extraStopsCount: request.extraStopsCount ?? 0,
    discountPercent: request.discountPercent ?? 0,
    discountAmount: request.discountAmount ?? 0,
    minimumFare,
  });

  logger.info(`[PRICING] Finalize ride ${request.rideId}: dynamic=₹${request.dynamicFare} → final=₹${result.finalFare}`);

  return {
    finalFare: result.finalFare,
    breakdown: result.breakdown as unknown as Record<string, number>,
  };
}

// ============================================================
// Get pricing rules (for admin/display)
// ============================================================

export function getPricingRules() {
  return {
    algorithmVersion: 'pricing_policy_v2',
    vehicleTypes: ['bike_rescue', 'auto', 'cab_mini', 'cab_xl', 'cab_premium', 'personal_driver', 'eco_pickup'],
    surgeEnabled: true,
    peakHourEnabled: true,
    weatherEnabled: true,
    marketplaceModes: ['launch', 'scale'],
    burnGuardEnabled: true,
    contributionGuardEnabled: true,
  };
}

// ============================================================
// H3-based nearby driver search
// ============================================================

function calcDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return getDistance(
    { latitude: lat1, longitude: lng1 },
    { latitude: lat2, longitude: lng2 }
  ) / 1000;
}

export async function getNearbyDrivers(
  lat: number,
  lng: number,
  radiusKm: number = 5,
  vehicleType?: string
) {
  const startTime = Date.now();
  const h3Config = getH3Config();
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  const pickupH3 = latLngToH3(lat, lng);

  logger.info(`[H3-NEARBY] Location: (${lat}, ${lng}) H3: ${pickupH3}`);

  const iterations: Array<{ k: number; cellCount: number; driversFound: number }> = [];
  let finalDrivers: any[] = [];
  const heartbeatThreshold = new Date(Date.now() - 5 * 60 * 1000);

  for (let k = 1; k <= h3Config.maxKRing; k++) {
    const searchCells = getKRing(pickupH3, k);
    const approxRadiusKm = estimateKRingRadiusKm(k);

    const whereClause: any = {
      h3Index: { in: searchCells },
      isOnline: true,
      isActive: true,
      lastActiveAt: { gte: heartbeatThreshold },
      currentLatitude: { not: null },
      currentLongitude: { not: null },
    };

    if (!isDev) whereClause.isVerified = true;
    if (vehicleType) whereClause.vehicleType = vehicleType;

    const drivers = await prisma.driver.findMany({
      where: whereClause,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, profileImage: true, phone: true } },
      },
    });

    const driversWithDistance = drivers
      .map((d) => ({
        ...d,
        distance: calcDistance(lat, lng, d.currentLatitude!, d.currentLongitude!),
        h3Index: d.h3Index,
      }))
      .filter((d) => d.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance);

    iterations.push({ k, cellCount: searchCells.length, driversFound: driversWithDistance.length });

    if (driversWithDistance.length > 0) {
      finalDrivers = driversWithDistance;
      break;
    }
  }

  const matchingTimeMs = Date.now() - startTime;
  const matchingLog = createMatchingLog(lat, lng, pickupH3, iterations, matchingTimeMs);
  logMatchingProcess(matchingLog);

  logger.info(`[H3-NEARBY] Found ${finalDrivers.length} drivers in ${matchingTimeMs}ms`);

  return finalDrivers;
}

// Re-export for ride-service compatibility (response shape)
export interface PricingResponse {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  totalFare: number;
  distance: number;
  estimatedDuration: number;
  vehicleType: string;
  surgeMultiplier: number;
  breakdown?: any;
}
