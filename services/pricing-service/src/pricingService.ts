import { getDistance, getBoundsOfDistance } from 'geolib';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { 
  latLngToH3, 
  getKRing, 
  getH3Config, 
  createMatchingLog, 
  logMatchingProcess,
  estimateKRingRadiusKm,
  estimateKRingCellCount,
  type H3MatchingLog
} from '@raahi/shared';

const logger = createLogger('pricing-service');

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
  surgeMultiplier: number;
  peakHourMultiplier: number;
  totalFare: number;
  distance: number;
  estimatedDuration: number;
  breakdown: Record<string, number>;
}

async function getCurrentPricingRule() {
  const now = new Date();
  const rule = await prisma.pricingRule.findFirst({
    where: {
      isActive: true,
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gte: now } }],
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!rule) {
    return {
      baseFare: parseFloat(process.env.BASE_FARE || '25'),
      perKmRate: parseFloat(process.env.PER_KM_RATE || '12'),
      perMinuteRate: parseFloat(process.env.PER_MINUTE_RATE || '2'),
      surgeMultiplier: 1.0,
      peakHourMultiplier: 1.0,
    };
  }
  return rule;
}

function calcDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return getDistance({ latitude: lat1, longitude: lng1 }, { latitude: lat2, longitude: lng2 }) / 1000;
}

function estimateDuration(distance: number): number {
  return Math.ceil((distance / 25) * 60);
}

// Maximum surge multiplier cap (from env or default 3.0)
const MAX_SURGE_MULTIPLIER = parseFloat(process.env.SURGE_MULTIPLIER_MAX || '3.0');

/**
 * Calculate surge multiplier based on multiple factors:
 * 1. Static surge areas (admin-defined zones with fixed multipliers)
 * 2. Dynamic surge based on demand/driver ratio
 * 3. Time-based surge (peak hours)
 * 
 * Returns the highest applicable surge, capped at MAX_SURGE_MULTIPLIER
 */
async function calculateSurgeMultiplier(lat: number, lng: number, scheduledTime?: Date): Promise<number> {
  const surgeFactors: { source: string; multiplier: number }[] = [];
  
  // ==================== 1. STATIC SURGE AREAS ====================
  // Get all active surge areas and check if location is within their radius
  const activeSurgeAreas = await prisma.surgeArea.findMany({
    where: { isActive: true },
  });
  
  for (const area of activeSurgeAreas) {
    // Calculate actual distance from surge area center using Haversine formula
    const distance = calcDistance(lat, lng, area.centerLatitude, area.centerLongitude);
    
    // Check if location is within the surge area's radius
    if (distance <= area.radius) {
      surgeFactors.push({
        source: `SurgeArea: ${area.name}`,
        multiplier: area.multiplier,
      });
      logger.info(`[SURGE] Location is within surge area "${area.name}" (${distance.toFixed(2)}km from center, radius: ${area.radius}km) - multiplier: ${area.multiplier}x`);
    }
  }
  
  // ==================== 2. DYNAMIC SURGE (DEMAND/SUPPLY) ====================
  // Calculate demand ratio based on active rides vs available drivers in the area
  const searchRadius = 5; // km
  const latRange = searchRadius / 111;
  const lngRange = searchRadius / (111 * Math.cos((lat * Math.PI) / 180));
  
  const [availableDrivers, activeRideRequests] = await Promise.all([
    // Count online, active drivers in the area
    prisma.driver.count({
      where: {
        isOnline: true,
        isActive: true,
        currentLatitude: { gte: lat - latRange, lte: lat + latRange },
        currentLongitude: { gte: lng - lngRange, lte: lng + lngRange },
      },
    }),
    // Count pending/active ride requests in the area
    prisma.ride.count({
      where: {
        status: { in: ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED'] },
        pickupLatitude: { gte: lat - latRange, lte: lat + latRange },
        pickupLongitude: { gte: lng - lngRange, lte: lng + lngRange },
        createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) }, // Last 15 minutes
      },
    }),
  ]);
  
  // Calculate demand-based surge
  let demandSurge = 1.0;
  if (availableDrivers === 0) {
    // No drivers available - high surge
    demandSurge = 2.5;
    logger.info(`[SURGE] No drivers available in area - demand surge: ${demandSurge}x`);
  } else {
    const demandRatio = activeRideRequests / availableDrivers;
    
    // Surge tiers based on demand ratio
    if (demandRatio >= 3.0) {
      demandSurge = 2.5; // Very high demand
    } else if (demandRatio >= 2.0) {
      demandSurge = 2.0; // High demand
    } else if (demandRatio >= 1.5) {
      demandSurge = 1.7; // Moderate-high demand
    } else if (demandRatio >= 1.0) {
      demandSurge = 1.4; // Moderate demand
    } else if (demandRatio >= 0.5) {
      demandSurge = 1.2; // Low-moderate demand
    }
    // else demandSurge stays 1.0 (normal)
    
    logger.info(`[SURGE] Demand analysis: ${activeRideRequests} rides, ${availableDrivers} drivers, ratio: ${demandRatio.toFixed(2)} - demand surge: ${demandSurge}x`);
  }
  
  if (demandSurge > 1.0) {
    surgeFactors.push({
      source: 'Dynamic (demand/supply)',
      multiplier: demandSurge,
    });
  }
  
  // ==================== 3. TIME-BASED SURGE ====================
  const hour = (scheduledTime || new Date()).getHours();
  let timeSurge = 1.0;
  
  // Morning rush hour: 7-9 AM
  if (hour >= 7 && hour <= 9) {
    timeSurge = 1.3;
  }
  // Evening rush hour: 5-8 PM
  else if (hour >= 17 && hour <= 20) {
    timeSurge = 1.3;
  }
  // Late night: 11 PM - 5 AM (safety/availability premium)
  else if (hour >= 23 || hour <= 5) {
    timeSurge = 1.2;
  }
  
  if (timeSurge > 1.0) {
    surgeFactors.push({
      source: `Time-based (hour: ${hour})`,
      multiplier: timeSurge,
    });
    logger.info(`[SURGE] Time-based surge for hour ${hour}: ${timeSurge}x`);
  }
  
  // ==================== CALCULATE FINAL SURGE ====================
  // Use the highest surge factor (not multiplicative to avoid extreme values)
  let finalSurge = 1.0;
  let surgeSource = 'None';
  
  for (const factor of surgeFactors) {
    if (factor.multiplier > finalSurge) {
      finalSurge = factor.multiplier;
      surgeSource = factor.source;
    }
  }
  
  // Apply maximum cap
  if (finalSurge > MAX_SURGE_MULTIPLIER) {
    logger.info(`[SURGE] Surge ${finalSurge}x exceeds max ${MAX_SURGE_MULTIPLIER}x - capping`);
    finalSurge = MAX_SURGE_MULTIPLIER;
  }
  
  logger.info(`[SURGE] Final surge: ${finalSurge}x (source: ${surgeSource})`);
  
  return finalSurge;
}

function peakHourMultiplier(scheduledTime?: Date): number {
  const time = scheduledTime || new Date();
  const hour = time.getHours();
  if (hour >= 7 && hour <= 9) return 1.5;
  if (hour >= 17 && hour <= 20) return 1.5;
  return 1.0;
}

export async function calculateFare(request: PricingRequest): Promise<PricingResponse> {
  const rule = await getCurrentPricingRule();
  const distance = calcDistance(request.pickupLat, request.pickupLng, request.dropLat, request.dropLng);
  const estimatedDuration = estimateDuration(distance);
  const baseFare = rule.baseFare;
  const distanceFare = distance * rule.perKmRate;
  const timeFare = estimatedDuration * rule.perMinuteRate;
  const surgeMultiplier = await calculateSurgeMultiplier(request.pickupLat, request.pickupLng, request.scheduledTime);
  const peakHourMult = peakHourMultiplier(request.scheduledTime);
  const subtotal = baseFare + distanceFare + timeFare;
  const totalFare = subtotal * surgeMultiplier * peakHourMult;
  return {
    baseFare,
    distanceFare,
    timeFare,
    surgeMultiplier,
    peakHourMultiplier: peakHourMult,
    totalFare: Math.round(totalFare * 100) / 100,
    distance: Math.round(distance * 100) / 100,
    estimatedDuration,
    breakdown: {
      baseFare,
      distanceFare,
      timeFare,
      surgeAmount: Math.round(subtotal * (surgeMultiplier - 1) * 100) / 100,
      peakHourAmount: Math.round(subtotal * (peakHourMult - 1) * 100) / 100,
      subtotal: Math.round(subtotal * 100) / 100,
      total: Math.round(totalFare * 100) / 100,
    },
  };
}

/**
 * H3-based nearby driver search with progressive kRing expansion
 * 
 * This replaces the naive bounding-box approach with Uber's H3 hexagonal
 * geospatial indexing for efficient, indexed queries.
 * 
 * Performance benefits:
 * - Uses indexed h3Index column for fast lookups
 * - No full table scans - queries only matching H3 cells
 * - Progressive expansion: starts small, expands only if needed
 * 
 * @param lat - Pickup latitude
 * @param lng - Pickup longitude
 * @param radiusKm - Maximum search radius (used for final distance filter)
 * @param vehicleType - Optional vehicle type filter
 * @returns Array of nearby drivers sorted by distance
 */
export async function getNearbyDrivers(
  lat: number, 
  lng: number, 
  radiusKm: number = 5,
  vehicleType?: string
) {
  const startTime = Date.now();
  const h3Config = getH3Config();
  
  // In development mode, relax the isVerified requirement to allow testing
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  
  // Convert pickup location to H3 index
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
  
  // Track iterations for logging
  const iterations: Array<{ k: number; cellCount: number; driversFound: number }> = [];
  let finalDrivers: any[] = [];
  
  // Heartbeat threshold: drivers must have been active within this time
  const heartbeatThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes
  
  // Progressive kRing expansion: start with k=1, expand up to maxK
  for (let k = 1; k <= h3Config.maxKRing; k++) {
    const searchCells = getKRing(pickupH3, k);
    const approxRadiusKm = estimateKRingRadiusKm(k);
    
    logger.info(`[H3-NEARBY] Searching k=${k}: ${searchCells.length} cells, ~${approxRadiusKm.toFixed(2)}km radius`);
    
    // Build query with H3 index - this uses the DB index!
    const whereClause: any = {
      h3Index: { in: searchCells },  // Indexed query - no full table scan
      isOnline: true,
      isActive: true,
      lastActiveAt: { gte: heartbeatThreshold },  // Recent heartbeat check
      currentLatitude: { not: null },
      currentLongitude: { not: null },
    };
    
    // Only require verification in production
    if (!isDev) {
      whereClause.isVerified = true;
    }
    
    // Vehicle type filter
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
    
    // Calculate actual distances and filter by radius
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
    
    // If we found drivers, we're done
    if (driversWithDistance.length > 0) {
      finalDrivers = driversWithDistance;
      
      // Log found drivers
      driversWithDistance.forEach(driver => {
        const name = `${driver.user.firstName} ${driver.user.lastName || ''}`.trim();
        logger.info(`[H3-NEARBY]   ✅ Driver ${driver.id} (${name}): ${driver.distance.toFixed(2)}km, h3=${driver.h3Index}`);
      });
      
      break;
    }
    
    // If at max k and still no drivers, log diagnostic info
    if (k === h3Config.maxKRing && driversWithDistance.length === 0) {
      logger.warn(`[H3-NEARBY] ⚠️ No drivers found after max expansion (k=${h3Config.maxKRing})`);
      
      // Get diagnostic info - how many drivers exist with various states
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
  
  // Create and log the matching record
  const matchingLog = createMatchingLog(lat, lng, pickupH3, iterations, matchingTimeMs);
  logMatchingProcess(matchingLog);
  
  logger.info(`[H3-NEARBY] ========== SEARCH COMPLETE ==========`);
  logger.info(`[H3-NEARBY] Total time: ${matchingTimeMs}ms`);
  logger.info(`[H3-NEARBY] Final k: ${matchingLog.finalK}`);
  logger.info(`[H3-NEARBY] Drivers found: ${finalDrivers.length}`);
  
  // Fail explicitly if we expected drivers but found none due to potential bug
  // This helps detect logic errors in the matching system
  if (finalDrivers.length === 0 && iterations.some(i => i.driversFound > 0)) {
    logger.error(`[H3-NEARBY] 🚨 MATCHING BUG: Found drivers in iterations but final result is empty!`);
    throw new Error('H3 matching logic error: drivers found but not returned');
  }
  
  return finalDrivers;
}

/**
 * Legacy bounding-box based nearby driver search
 * Kept for backward compatibility and fallback
 * 
 * @deprecated Use getNearbyDrivers (H3-based) instead
 */
export async function getNearbyDriversLegacy(lat: number, lng: number, radiusKm: number = 5) {
  const bounds = getBoundsOfDistance({ latitude: lat, longitude: lng }, radiusKm * 1000);
  
  // In development mode, relax the isVerified requirement to allow testing
  const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  
  logger.info(`[NEARBY-LEGACY] Location: (${lat}, ${lng}), Radius: ${radiusKm}km`);
  
  const whereClause: any = {
    isActive: true,
    isOnline: true,
    currentLatitude: { gte: bounds[0].latitude, lte: bounds[1].latitude },
    currentLongitude: { gte: bounds[0].longitude, lte: bounds[1].longitude },
  };
  
  // Only require verification in production
  if (!isDev) {
    whereClause.isVerified = true;
  }
  
  const drivers = await prisma.driver.findMany({
    where: whereClause,
    include: { user: { select: { id: true, firstName: true, lastName: true, profileImage: true, phone: true } } },
  });
  
  const result = drivers
    .filter((d) => d.currentLatitude != null && d.currentLongitude != null)
    .map((d) => ({
      ...d,
      distance: calcDistance(lat, lng, d.currentLatitude!, d.currentLongitude!),
    }))
    .filter((d) => d.distance <= radiusKm)
    .sort((a, b) => a.distance - b.distance);
  
  logger.info(`[NEARBY-LEGACY] Found ${result.length} drivers`);
  
  return result;
}
