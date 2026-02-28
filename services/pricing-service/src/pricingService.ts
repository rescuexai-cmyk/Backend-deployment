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

const logger = createLogger('pricing-service');

// ============================================================
// Vehicle-type pricing configuration (Absolute Pricing Model)
// No surge. No peak-hour multiplier.
// ============================================================

export type VehicleType = 'cab' | 'auto' | 'bike';

interface VehicleRate {
  baseFare: number;
  perKmRate: number;
  perMinuteRate: number;
}

const VEHICLE_RATES: Record<VehicleType, VehicleRate> = {
  cab: {
    baseFare: 30,
    perKmRate: 15,
    perMinuteRate: 1.5,
  },
  auto: {
    baseFare: 30,
    perKmRate: 10,
    perMinuteRate: 1,
  },
  bike: {
    baseFare: 20,
    perKmRate: 7,
    perMinuteRate: 1,
  },
};

// Fixed fees applied to every ride (in ₹)
const SERVICE_FEE = 10;
const INSURANCE_FEE = 2;
const PLATFORM_FEE = 10;

function getVehicleRate(vehicleType?: string): { rate: VehicleRate; type: VehicleType } {
  const normalized = (vehicleType || 'cab').toLowerCase() as VehicleType;
  const rate = VEHICLE_RATES[normalized];
  if (!rate) {
    logger.warn(`[PRICING] Unknown vehicle type "${vehicleType}", defaulting to cab`);
    return { rate: VEHICLE_RATES.cab, type: 'cab' };
  }
  return { rate, type: normalized };
}

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

export interface PricingResponse {
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  serviceFee: number;
  insuranceFee: number;
  platformFee: number;
  totalFare: number;
  distance: number;
  estimatedDuration: number;
  vehicleType: string;
  breakdown: {
    baseFare: number;
    distanceFare: number;
    timeFare: number;
    rideFare: number;
    serviceFee: number;
    insuranceFee: number;
    platformFee: number;
    totalFees: number;
    total: number;
  };
  // Kept for backward compatibility (always 1.0 now)
  surgeMultiplier: number;
  peakHourMultiplier: number;
}

// ============================================================
// Helpers
// ============================================================

function calcDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return getDistance({ latitude: lat1, longitude: lng1 }, { latitude: lat2, longitude: lng2 }) / 1000;
}

function estimateDuration(distanceKm: number): number {
  // Average city speed ~25 km/h
  return Math.ceil((distanceKm / 25) * 60);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ============================================================
// Fare Calculation (Absolute Pricing – no surge)
//
// Formula:
//   rideFare   = baseFare + (distance × perKmRate) + (duration × perMinuteRate)
//   totalFare  = rideFare + serviceFee + insuranceFee + platformFee
// ============================================================

export async function calculateFare(request: PricingRequest): Promise<PricingResponse> {
  const { rate, type } = getVehicleRate(request.vehicleType);

  const distance = calcDistance(
    request.pickupLat, request.pickupLng,
    request.dropLat, request.dropLng,
  );
  const estimatedDuration = estimateDuration(distance);

  const baseFare = rate.baseFare;
  const distanceFare = round2(distance * rate.perKmRate);
  const timeFare = round2(estimatedDuration * rate.perMinuteRate);
  const rideFare = round2(baseFare + distanceFare + timeFare);

  const totalFees = SERVICE_FEE + INSURANCE_FEE + PLATFORM_FEE;
  const totalFare = round2(rideFare + totalFees);

  logger.info(`[PRICING] ${type.toUpperCase()} | ${round2(distance)}km | ${estimatedDuration}min | ride=₹${rideFare} + fees=₹${totalFees} = ₹${totalFare}`);

  return {
    baseFare,
    distanceFare,
    timeFare,
    serviceFee: SERVICE_FEE,
    insuranceFee: INSURANCE_FEE,
    platformFee: PLATFORM_FEE,
    totalFare,
    distance: round2(distance),
    estimatedDuration,
    vehicleType: type,
    surgeMultiplier: 1.0,
    peakHourMultiplier: 1.0,
    breakdown: {
      baseFare,
      distanceFare,
      timeFare,
      rideFare,
      serviceFee: SERVICE_FEE,
      insuranceFee: INSURANCE_FEE,
      platformFee: PLATFORM_FEE,
      totalFees,
      total: totalFare,
    },
  };
}

// ============================================================
// Multi-vehicle fare: return prices for all vehicle types at once
// ============================================================

export async function calculateAllFares(
  pickupLat: number, pickupLng: number,
  dropLat: number, dropLng: number,
): Promise<Record<VehicleType, PricingResponse>> {
  const types: VehicleType[] = ['cab', 'auto', 'bike'];
  const results = {} as Record<VehicleType, PricingResponse>;

  for (const vt of types) {
    results[vt] = await calculateFare({
      pickupLat, pickupLng, dropLat, dropLng,
      vehicleType: vt,
    });
  }

  return results;
}

// ============================================================
// Get current pricing rules (for admin / display purposes)
// ============================================================

export function getPricingRules() {
  return {
    vehicleRates: VEHICLE_RATES,
    fees: {
      serviceFee: SERVICE_FEE,
      insuranceFee: INSURANCE_FEE,
      platformFee: PLATFORM_FEE,
      totalFees: SERVICE_FEE + INSURANCE_FEE + PLATFORM_FEE,
    },
    surgeEnabled: false,
    peakHourEnabled: false,
  };
}

// ============================================================
// H3-based nearby driver search (unchanged)
// ============================================================

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
  
  logger.info(`[H3-NEARBY] ========== H3 DRIVER SEARCH ==========`);
  logger.info(`[H3-NEARBY] Location: (${lat}, ${lng})`);
  logger.info(`[H3-NEARBY] H3 Index: ${pickupH3}`);
  logger.info(`[H3-NEARBY] Resolution: ${h3Config.resolution}`);
  logger.info(`[H3-NEARBY] Max kRing: ${h3Config.maxKRing}`);
  logger.info(`[H3-NEARBY] Mode: ${isDev ? 'DEVELOPMENT' : 'PRODUCTION'}`);
  if (vehicleType) {
    logger.info(`[H3-NEARBY] Vehicle Type Filter: ${vehicleType}`);
  }
  
  const iterations: Array<{ k: number; cellCount: number; driversFound: number }> = [];
  let finalDrivers: any[] = [];
  
  const heartbeatThreshold = new Date(Date.now() - 5 * 60 * 1000);
  
  for (let k = 1; k <= h3Config.maxKRing; k++) {
    const searchCells = getKRing(pickupH3, k);
    const approxRadiusKm = estimateKRingRadiusKm(k);
    
    logger.info(`[H3-NEARBY] Searching k=${k}: ${searchCells.length} cells, ~${approxRadiusKm.toFixed(2)}km radius`);
    
    const whereClause: any = {
      h3Index: { in: searchCells },
      isOnline: true,
      isActive: true,
      lastActiveAt: { gte: heartbeatThreshold },
      currentLatitude: { not: null },
      currentLongitude: { not: null },
    };
    
    if (!isDev) {
      whereClause.isVerified = true;
    }
    
    if (vehicleType) {
      whereClause.vehicleType = vehicleType;
    }
    
    const drivers = await prisma.driver.findMany({
      where: whereClause,
      include: { 
        user: { 
          select: { id: true, firstName: true, lastName: true, profileImage: true, phone: true } 
        } 
      },
    });
    
    const driversWithDistance = drivers
      .map(d => ({
        ...d,
        distance: calcDistance(lat, lng, d.currentLatitude!, d.currentLongitude!),
        h3Index: d.h3Index,
      }))
      .filter(d => d.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance);
    
    iterations.push({
      k,
      cellCount: searchCells.length,
      driversFound: driversWithDistance.length,
    });
    
    logger.info(`[H3-NEARBY]   → Found ${driversWithDistance.length} drivers within ${radiusKm}km`);
    
    if (driversWithDistance.length > 0) {
      finalDrivers = driversWithDistance;
      
      driversWithDistance.forEach(driver => {
        const name = `${driver.user.firstName} ${driver.user.lastName || ''}`.trim();
        logger.info(`[H3-NEARBY]   ✅ Driver ${driver.id} (${name}): ${driver.distance.toFixed(2)}km, h3=${driver.h3Index}`);
      });
      
      break;
    }
    
    if (k === h3Config.maxKRing && driversWithDistance.length === 0) {
      logger.warn(`[H3-NEARBY] ⚠️ No drivers found after max expansion (k=${h3Config.maxKRing})`);
      
      const [totalOnline, totalWithH3, totalInArea] = await Promise.all([
        prisma.driver.count({ where: { isOnline: true, isActive: true } }),
        prisma.driver.count({ where: { isOnline: true, isActive: true, h3Index: { not: null } } }),
        prisma.driver.count({ where: { h3Index: { in: searchCells } } }),
      ]);
      
      logger.warn(`[H3-NEARBY] Diagnostics:`);
      logger.warn(`[H3-NEARBY]   - Online & Active drivers: ${totalOnline}`);
      logger.warn(`[H3-NEARBY]   - With H3 index: ${totalWithH3}`);
      logger.warn(`[H3-NEARBY]   - In search area (any status): ${totalInArea}`);
      logger.warn(`[H3-NEARBY]   - Heartbeat threshold: ${heartbeatThreshold.toISOString()}`);
    }
  }
  
  const matchingTimeMs = Date.now() - startTime;
  
  const matchingLog = createMatchingLog(lat, lng, pickupH3, iterations, matchingTimeMs);
  logMatchingProcess(matchingLog);
  
  logger.info(`[H3-NEARBY] ========== SEARCH COMPLETE ==========`);
  logger.info(`[H3-NEARBY] Total time: ${matchingTimeMs}ms`);
  logger.info(`[H3-NEARBY] Final k: ${matchingLog.finalK}`);
  logger.info(`[H3-NEARBY] Drivers found: ${finalDrivers.length}`);
  
  if (finalDrivers.length === 0 && iterations.some(i => i.driversFound > 0)) {
    logger.error(`[H3-NEARBY] 🚨 MATCHING BUG: Found drivers in iterations but final result is empty!`);
    throw new Error('H3 matching logic error: drivers found but not returned');
  }
  
  return finalDrivers;
}
