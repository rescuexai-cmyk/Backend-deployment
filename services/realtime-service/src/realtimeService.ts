import { prisma, latLngToH3, getH3Config, getKRing } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import type { Server as SocketServer } from 'socket.io';
import { eventBus, CHANNELS } from './eventBus';
import { sseManager } from './sseManager';
import { mqttBroker } from './mqttBroker';

const logger = createLogger('realtime-service');
let io: SocketServer | null = null;

// Push notification service configuration
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5006';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';
const RIDE_OFFER_PUSH_EVENT = 'NEW_RIDE_REQUEST';
const RIDE_OFFER_PUSH_TTL_MS = 30_000;
const rideOfferPushDedupe = new Map<string, number>();
const ARRIVAL_RADIUS_METERS = 120;
const ARRIVAL_RADIUS_HYSTERESIS_METERS = 150;
const pickupRadiusState = new Map<string, boolean>(); // rideId -> inside radius with jitter guard
const pickupRadiusNotified = new Set<string>(); // rideIds already notified once

function shouldSendRideOfferPush(rideId: string, driverId: string): boolean {
  const now = Date.now();
  const dedupeKey = `${rideId}:${driverId}:${RIDE_OFFER_PUSH_EVENT}`;

  // Opportunistic cleanup of expired keys
  for (const [key, expiresAt] of rideOfferPushDedupe.entries()) {
    if (expiresAt <= now) {
      rideOfferPushDedupe.delete(key);
    }
  }

  const expiresAt = rideOfferPushDedupe.get(dedupeKey);
  if (expiresAt && expiresAt > now) {
    return false;
  }

  rideOfferPushDedupe.set(dedupeKey, now + RIDE_OFFER_PUSH_TTL_MS);
  return true;
}

/**
 * Send push notification for new ride request to a driver
 * Non-blocking - failures are logged but don't affect the main broadcast
 */
async function sendRideRequestPushNotification(
  driverId: string,
  rideId: string,
  rideData: {
    pickupAddress: string;
    totalFare: number;
    distance: number;
    pickupLatitude?: number;
    pickupLongitude?: number;
    dropLatitude?: number;
    dropLongitude?: number;
    vehicleType?: string;
  }
): Promise<void> {
  try {
    // Get driver's user ID for push notification
    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    });
    
    if (!driver?.userId) {
      logger.debug(`[PUSH] No user ID for driver ${driverId}, skipping push`);
      return;
    }

    const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications/internal/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        userId: driver.userId,
        title: 'New Ride Request',
        body: 'Pickup nearby',
        data: {
          type: 'RIDE_UPDATE',
          event: RIDE_OFFER_PUSH_EVENT,
          rideId,
          pickupAddress: rideData.pickupAddress,
          pickupLat: rideData.pickupLatitude?.toString() ?? '',
          pickupLng: rideData.pickupLongitude?.toString() ?? '',
          dropLat: rideData.dropLatitude?.toString() ?? '',
          dropLng: rideData.dropLongitude?.toString() ?? '',
          fareEstimate: rideData.totalFare.toString(),
          vehicleType: rideData.vehicleType || '',
          distance: rideData.distance.toString(),
        },
      }),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.success) {
        logger.info(`[PUSH] Sent ${RIDE_OFFER_PUSH_EVENT} to driver ${driverId}`);
      }
    }
  } catch (error) {
    logger.warn(`[PUSH] Failed to send ride request push to driver ${driverId}`, { error });
    // Non-blocking - continue with socket broadcast
  }
}

async function sendDriverNearPickupPushNotification(
  passengerUserId: string,
  rideId: string,
  driverName: string,
): Promise<void> {
  try {
    const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications/internal/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        userId: passengerUserId,
        title: 'Driver is arriving',
        body: `${driverName} has almost reached your location. Be ready.`,
        data: {
          type: 'DRIVER_NEAR_PICKUP',
          rideId,
          driverName,
          event: 'DRIVER_NEAR_PICKUP',
        },
        saveToDb: true,
      }),
    });

    if (!response.ok) {
      logger.warn('[ARRIVAL_RADIUS] Failed to send DRIVER_NEAR_PICKUP push', {
        rideId,
        passengerUserId,
        status: response.status,
      });
    }
  } catch (error) {
    logger.warn('[ARRIVAL_RADIUS] Error sending DRIVER_NEAR_PICKUP push', {
      rideId,
      passengerUserId,
      error,
    });
  }
}

function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function normalizeVehicleCategory(raw: string | null | undefined): 'bike' | 'auto' | 'cab' | null {
  if (!raw) return null;
  const value = raw.toLowerCase().trim().replace(/-/g, '_');
  if (['bike', 'bike_rescue', 'motorbike'].includes(value)) return 'bike';
  if (value === 'auto') return 'auto';
  if (
    [
      'cab',
      'cab_mini',
      'cab_sedan',
      'cab_xl',
      'cab_suv',
      'cab_premium',
      'personal_driver',
      'commercial_car',
    ].includes(value)
  ) {
    return 'cab';
  }
  return null;
}

function isVehicleCompatible(
  rideVehicleType: string | null | undefined,
  driverVehicleType: string | null | undefined,
): boolean {
  const rideCategory = normalizeVehicleCategory(rideVehicleType);
  if (!rideCategory) return true;
  const driverCategory = normalizeVehicleCategory(driverVehicleType);
  if (!driverCategory) return false;
  return rideCategory === driverCategory;
}

// Shared driver tracking maps (set by index.ts)
let connectedDrivers: Map<string, string> | null = null; // socketId -> driverId
let driverSockets: Map<string, Set<string>> | null = null; // driverId -> Set of socketIds

export function setIo(socketServer: SocketServer) {
  io = socketServer;
}

export function setDriverMaps(
  _connectedDrivers: Map<string, string>,
  _driverSockets: Map<string, Set<string>>
) {
  connectedDrivers = _connectedDrivers;
  driverSockets = _driverSockets;
  logger.info('[REALTIME] Driver maps initialized');
}

export async function getRealTimeStats() {
  try {
    const [totalDrivers, onlineDrivers, activeRides, completedRidesToday, surgeAreas] = await Promise.all([
      prisma.driver.count(),
      prisma.driver.count({ where: { isOnline: true } }),
      prisma.ride.count({
        where: {
          status: { in: ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'RIDE_STARTED'] },
        },
      }),
      prisma.ride.count({
        where: {
          status: 'RIDE_COMPLETED',
          completedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
      }),
      prisma.surgeArea.count({ where: { isActive: true } }),
    ]);
    const averageWaitTime = 5; // simplified
    return {
      totalDrivers,
      onlineDrivers,
      activeRides,
      completedRidesToday,
      averageWaitTime,
      surgeAreas,
    };
  } catch (error) {
    logger.error('[REALTIME] Failed to get realtime stats', { error });
    // Return safe defaults on error
    return {
      totalDrivers: 0,
      onlineDrivers: 0,
      activeRides: 0,
      completedRidesToday: 0,
      averageWaitTime: 5,
      surgeAreas: 0,
    };
  }
}

export async function getLocationStats(lat: number, lng: number, radius: number = 5) {
  const latRange = radius / 111;
  const lngRange = radius / (111 * Math.cos((lat * Math.PI) / 180));
  const [availableDrivers, activeRides] = await Promise.all([
    prisma.driver.count({
      where: {
        isOnline: true,
        isActive: true,
        currentLatitude: { gte: lat - latRange, lte: lat + latRange },
        currentLongitude: { gte: lng - lngRange, lte: lng + lngRange },
      },
    }),
    prisma.ride.count({
      where: {
        status: { in: ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'RIDE_STARTED'] },
        pickupLatitude: { gte: lat - latRange, lte: lat + latRange },
        pickupLongitude: { gte: lng - lngRange, lte: lng + lngRange },
      },
    }),
  ]);
  const demandRatio = availableDrivers > 0 ? activeRides / availableDrivers : 2.0;
  const avgFareResult = await prisma.ride.aggregate({
    where: {
      status: 'RIDE_COMPLETED',
      pickupLatitude: { gte: lat - latRange, lte: lat + latRange },
      pickupLongitude: { gte: lng - lngRange, lte: lng + lngRange },
      completedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    _avg: { totalFare: true },
  });
  return {
    lat,
    lng,
    radius,
    availableDrivers,
    activeRides,
    demandRatio,
    averageFare: avgFareResult._avg.totalFare || 0,
  };
}

export async function updateDriverLocation(driverId: string, lat: number, lng: number, heading?: number, speed?: number) {
  // Convert lat/lng to H3 index for efficient geospatial queries
  const h3Index = latLngToH3(lat, lng);
  const config = getH3Config();

  // Accept both driver record id and user id from clients and normalize.
  const dbDriver = await prisma.driver.findFirst({
    where: {
      OR: [{ id: driverId }, { userId: driverId }],
    },
    select: { id: true },
  });

  if (!dbDriver) {
    logger.warn(`[H3] updateDriverLocation skipped: driver not found for input=${driverId}`);
    return;
  }

  await prisma.driver.update({
    where: { id: dbDriver.id },
    data: {
      currentLatitude: lat,
      currentLongitude: lng,
      h3Index, // Store H3 index for geospatial matching
      lastActiveAt: new Date(),
    },
  });

  const canonicalDriverId = dbDriver.id;
  logger.debug(`[H3] Driver ${canonicalDriverId} location updated: h3Index=${h3Index}, res=${config.resolution}`);
  
  const timestamp = new Date().toISOString();

  // ── Broadcast via EventBus (reaches SSE + Socket.io + MQTT) ──────────────
  eventBus.publish(CHANNELS.driverLocations, {
    type: 'driver-location',
    driverId: canonicalDriverId,
    lat,
    lng,
    h3Index,
    heading,
    speed,
    timestamp,
  });

  // ── Direct MQTT publish for high-frequency location (bypass EventBus for perf) ──
  mqttBroker.publishDriverLocation(canonicalDriverId, lat, lng, h3Index, heading, speed);

  // ── Update SSE H3 subscriptions if driver moved to new cell ──────────────
  sseManager.updateDriverH3(canonicalDriverId, h3Index);

  // ── Legacy Socket.io broadcast (backward compatibility) ──────────────────
  if (io) {
    io.emit('driver-location-update', {
      driverId: canonicalDriverId,
      lat,
      lng,
      h3Index,
      heading,
      speed,
      timestamp,
    });
  }

  // Driver-near-pickup geofence detection (one-time notification per ride).
  try {
    const activePrePickupRide = await prisma.ride.findFirst({
      where: {
        driverId: canonicalDriverId,
        status: { in: ['DRIVER_ASSIGNED', 'CONFIRMED'] },
      },
      select: {
        id: true,
        passengerId: true,
        pickupLatitude: true,
        pickupLongitude: true,
        driver: {
          select: {
            user: {
              select: { firstName: true, lastName: true },
            },
          },
        },
      },
    });

    if (!activePrePickupRide) {
      return;
    }

    const rideId = activePrePickupRide.id;
    const meterDistance = distanceMeters(
      lat,
      lng,
      activePrePickupRide.pickupLatitude,
      activePrePickupRide.pickupLongitude,
    );

    const wasInside = pickupRadiusState.get(rideId) ?? false;
    const isInside = meterDistance <= ARRIVAL_RADIUS_METERS ||
      (wasInside && meterDistance <= ARRIVAL_RADIUS_HYSTERESIS_METERS);
    pickupRadiusState.set(rideId, isInside);

    if (isInside && !wasInside && !pickupRadiusNotified.has(rideId)) {
      pickupRadiusNotified.add(rideId);

      const firstName = activePrePickupRide.driver?.user?.firstName ?? '';
      const lastName = activePrePickupRide.driver?.user?.lastName ?? '';
      const driverName = `${firstName} ${lastName}`.trim() || 'Driver';

      await sendDriverNearPickupPushNotification(
        activePrePickupRide.passengerId,
        rideId,
        driverName,
      );

      broadcastRideStatusUpdate(rideId, 'DRIVER_NEAR_PICKUP', {
        rideId,
        driverName,
        distanceToPickupMeters: Math.round(meterDistance),
        arrivalRadiusMeters: ARRIVAL_RADIUS_METERS,
        event: 'DRIVER_NEAR_PICKUP',
      });

      logger.info('[ARRIVAL_RADIUS] Driver entered pickup radius', {
        rideId,
        driverId: canonicalDriverId,
        distanceToPickupMeters: Math.round(meterDistance),
      });
    }
  } catch (error) {
    logger.warn('[ARRIVAL_RADIUS] Geofence detection failed', { driverId: canonicalDriverId, error });
  }
}

/**
 * H3-based nearby driver search for realtime broadcast
 * 
 * Uses H3 hexagonal indexing for efficient geospatial queries.
 * Supports progressive kRing expansion to find drivers.
 * 
 * @param lat - Pickup latitude
 * @param lng - Pickup longitude
 * @param radius - Search radius in km (used for final distance filter)
 * @param vehicleType - Optional vehicle type filter
 * @returns Array of driver IDs
 */
export async function findNearbyDrivers(lat: number, lng: number, radius: number = 10, vehicleType?: string): Promise<string[]> {
  const { getKRing, getH3Config } = await import('@raahi/shared');
  
  const pickupH3 = latLngToH3(lat, lng);
  const h3Config = getH3Config();
  
  logger.debug(`[H3-REALTIME] Finding drivers near (${lat}, ${lng}), h3=${pickupH3}`);
  
  // Start with k=1 and expand up to maxK
  for (let k = 1; k <= h3Config.maxKRing; k++) {
    const searchCells = getKRing(pickupH3, k);
    
    const whereClause: any = {
      h3Index: { in: searchCells },
      isOnline: true,
      isActive: true,
    };
    
    const drivers = await prisma.driver.findMany({
      where: whereClause,
      select: { id: true, currentLatitude: true, currentLongitude: true, vehicleType: true },
    });
    
    // Filter by actual distance
    const nearbyDrivers = drivers.filter(d => {
      if (!d.currentLatitude || !d.currentLongitude) return false;
      if (!isVehicleCompatible(vehicleType, d.vehicleType)) return false;
      const dist = Math.sqrt(
        Math.pow((d.currentLatitude - lat) * 111, 2) + 
        Math.pow((d.currentLongitude - lng) * 111 * Math.cos(lat * Math.PI / 180), 2)
      );
      return dist <= radius;
    });
    
    if (nearbyDrivers.length > 0) {
      logger.debug(`[H3-REALTIME] Found ${nearbyDrivers.length} drivers at k=${k}`);
      return nearbyDrivers.map(d => d.id);
    }
  }
  
  logger.warn(`[H3-REALTIME] No nearby drivers found via H3 ring expansion, using online-driver fallback`);
  const fallbackDrivers = await prisma.driver.findMany({
    where: {
      isOnline: true,
      isActive: true,
    },
    select: { id: true, vehicleType: true },
    take: 200,
  });

  const compatible = fallbackDrivers
    .filter((driver) => isVehicleCompatible(vehicleType, driver.vehicleType))
    .map((driver) => driver.id);

  logger.info(
    `[H3-REALTIME] Fallback online drivers returned: ${compatible.length} (vehicleType=${vehicleType || 'any'})`,
  );
  return compatible;
}

/**
 * CRITICAL FUNCTION: Broadcast ride request to drivers
 * 
 * This function MUST:
 * 1. Log every step for debugging
 * 2. Verify drivers are actually connected
 * 3. FAIL LOUDLY if no drivers can receive the broadcast
 */
export function broadcastRideRequest(rideId: string, rideData: any, driverIds: string[]): {
  success: boolean;
  targetedDrivers: number;
  availableDrivers: number;
  connectedDrivers: number;
  errors: string[];
} {
  const result = {
    success: false,
    targetedDrivers: 0,
    availableDrivers: 0,
    connectedDrivers: 0,
    errors: [] as string[],
  };
  
  logger.info(`[BROADCAST] ========== RIDE REQUEST BROADCAST START ==========`);
  logger.info(`[BROADCAST] Ride ID: ${rideId}`);
  logger.info(`[BROADCAST] Pickup: ${rideData.pickupAddress} (${rideData.pickupLatitude}, ${rideData.pickupLongitude})`);
  logger.info(`[BROADCAST] Fare: ₹${rideData.totalFare}`);
  logger.info(`[BROADCAST] Target driver IDs from pricing service: ${JSON.stringify(driverIds)}`);
  
  // VALIDATION 1: Socket.io initialized
  if (!io) {
    const error = 'P0 ERROR: Socket.io not initialized - cannot broadcast ride request';
    logger.error(`[BROADCAST] ${error}`);
    result.errors.push(error);
    return result;
  }
  
  // VALIDATION 2: Check driver maps are initialized
  if (!connectedDrivers || !driverSockets) {
    const error = 'P0 ERROR: Driver tracking maps not initialized';
    logger.error(`[BROADCAST] ${error}`);
    result.errors.push(error);
    return result;
  }
  
  // Log current connection state
  result.connectedDrivers = driverSockets.size;
  logger.info(`[BROADCAST] Currently connected drivers (unique): ${result.connectedDrivers}`);
  logger.info(`[BROADCAST] Total socket connections: ${connectedDrivers.size}`);
  
  // Log all connected drivers for debugging
  if (driverSockets.size > 0) {
    driverSockets.forEach((sockets, driverId) => {
      const driverRoom = io!.sockets.adapter.rooms.get(`driver-${driverId}`);
      logger.info(`[BROADCAST]   - Driver ${driverId}: ${sockets.size} socket(s), room size: ${driverRoom?.size || 0}`);
    });
  } else {
    logger.warn(`[BROADCAST] ⚠️ NO DRIVERS CURRENTLY CONNECTED TO SOCKET.IO`);
  }
  
  const payload = {
    rideId,
    pickupLocation: {
      lat: rideData.pickupLatitude,
      lng: rideData.pickupLongitude,
      address: rideData.pickupAddress,
    },
    dropLocation: {
      lat: rideData.dropLatitude,
      lng: rideData.dropLongitude,
      address: rideData.dropAddress,
    },
    distance: rideData.distance,
    estimatedFare: rideData.totalFare,
    paymentMethod: rideData.paymentMethod,
    vehicleType: rideData.vehicleType || 'SEDAN',
    passengerName: rideData.passengerName || 'Passenger',
    timestamp: new Date().toISOString(),
  };
  
  // STEP 1: Send to specific nearby drivers
  logger.info(`[BROADCAST] Step 1: Targeting ${driverIds.length} specific drivers from nearby search`);
  
  const driversNotConnected: string[] = [];
  const driversEmitted: string[] = [];
  
  if (driverIds && driverIds.length > 0) {
    driverIds.forEach((driverId) => {
      const room = `driver-${driverId}`;
      const roomSize = io!.sockets.adapter.rooms.get(room)?.size || 0;
      const isTracked = driverSockets?.has(driverId) || false;
      
      if (roomSize > 0) {
        io!.to(room).emit('new-ride-request', payload);
        result.targetedDrivers++;
        driversEmitted.push(driverId);
        logger.info(`[BROADCAST]   ✅ EMITTED to driver ${driverId} (room: ${room}, sockets: ${roomSize})`);
      } else {
        driversNotConnected.push(driverId);
        logger.warn(`[BROADCAST]   ❌ Driver ${driverId} NOT in room (tracked: ${isTracked}, room size: ${roomSize})`);

        // P0 INCONSISTENCY: Driver is in DB as online but not connected to socket
        if (isTracked) {
          logger.error(`[BROADCAST]   🚨 P0 INCONSISTENCY: Driver ${driverId} is tracked but room is empty!`);
          result.errors.push(`Driver ${driverId} tracked but not in room`);
        }
      }
    });
  }

  // STEP 1.5: Always send push notification for ride offers to all matched drivers.
  // Non-blocking and deduped by rideId:driverId:event with 30s TTL.
  const uniqueDriverIds = Array.from(new Set(driverIds));
  void Promise.allSettled(
    uniqueDriverIds.map((driverId) => {
      if (!shouldSendRideOfferPush(rideId, driverId)) {
        logger.debug(`[PUSH] Dedupe hit for ${rideId}:${driverId}:${RIDE_OFFER_PUSH_EVENT}`);
        return Promise.resolve();
      }

      return sendRideRequestPushNotification(driverId, rideId, {
        pickupAddress: rideData.pickupAddress,
        totalFare: Number(rideData.totalFare || 0),
        distance: Number(rideData.distance || 0),
        pickupLatitude: rideData.pickupLatitude,
        pickupLongitude: rideData.pickupLongitude,
        dropLatitude: rideData.dropLatitude,
        dropLongitude: rideData.dropLongitude,
        vehicleType: rideData.vehicleType,
      });
    }),
  );
  
  // STEP 2: Fallback generic broadcast when targeted list is empty/unreachable.
  // This fail-open mode avoids P0 dispatch blackholes during matching drift.
  const shouldFallbackToGeneric = driverIds.length === 0 || result.targetedDrivers === 0;
  if (shouldFallbackToGeneric) {
    const availableRoomSize = io!.sockets.adapter.rooms.get('available-drivers')?.size || 0;
    result.availableDrivers = availableRoomSize;
    if (availableRoomSize > 0) {
      io!.to('available-drivers').emit('new-ride-request', payload);
      logger.warn(
        `[BROADCAST] Step 2: Fallback broadcast to available-drivers room (${availableRoomSize} sockets)`,
      );
    } else {
      logger.warn('[BROADCAST] Step 2: Fallback requested but available-drivers room is empty');
    }
  } else {
    result.availableDrivers = 0;
    logger.info('[BROADCAST] Step 2: Skipped generic fallback (targeted broadcast already delivered)');
  }
  
  // ── STEP 3: Broadcast via EventBus to SSE + MQTT transports ──────────────
  // This is the key improvement - SSE and MQTT provide reliable delivery
  // even when Socket.io connections fail (which caused "Start Ride" errors).
  
  const rideRequestEvent = {
    type: 'new-ride-request' as const,
    rideId,
    targetDriverIds: driverIds,
    payload,
  };
  
  // 3a: EventBus fallback fanout to available-drivers channel
  let sseAvailableSize = 0;
  if (shouldFallbackToGeneric) {
    sseAvailableSize = eventBus.getTotalListeners(CHANNELS.availableDrivers);
    if (sseAvailableSize > 0) {
      eventBus.publish(CHANNELS.availableDrivers, rideRequestEvent);
      logger.warn(
        `[BROADCAST]   ✅ EventBus fallback → available-drivers listeners: ${sseAvailableSize}`,
      );
    } else {
      logger.warn('[BROADCAST]   ⚠️ EventBus fallback requested but available-drivers has 0 listeners');
    }
  } else {
    logger.info('[BROADCAST]   ⏭️ EventBus available-drivers fallback skipped');
  }
  
  // 3b: Publish to individual driver channels (SSE + MQTT)
  let eventBusDriversReached = 0;
  for (const driverId of driverIds) {
    const listeners = eventBus.getTotalListeners(CHANNELS.driver(driverId));
    if (listeners > 0) {
      eventBus.publish(CHANNELS.driver(driverId), rideRequestEvent);
      eventBusDriversReached++;
    }
  }
  logger.info(`[BROADCAST]   ✅ EventBus → ${eventBusDriversReached}/${driverIds.length} individual drivers`);
  
  // 3c: Skip generic H3 fanout for ride requests.
  // H3 channels are geospatial only and not vehicle-segmented.
  logger.info(`[BROADCAST]   ⏭️ EventBus H3 broadcast skipped for strict vehicle targeting`);
  
  // SUMMARY
  logger.info(`[BROADCAST] ========== BROADCAST SUMMARY ==========`);
  logger.info(`[BROADCAST] Ride ID: ${rideId}`);
  logger.info(`[BROADCAST] Transport Results:`);
  logger.info(`[BROADCAST]   Socket.io: ${result.targetedDrivers} targeted, ${result.availableDrivers} in available room`);
  logger.info(`[BROADCAST]   EventBus:  ${eventBusDriversReached} targeted, ${sseAvailableSize} in available channel`);
  logger.info(`[BROADCAST] Drivers emitted to (Socket.io): ${JSON.stringify(driversEmitted)}`);
  logger.info(`[BROADCAST] Drivers NOT on Socket.io: ${JSON.stringify(driversNotConnected)}`);
  logger.info(`[BROADCAST] Total unique connected drivers (Socket.io): ${result.connectedDrivers}`);
  
  // DETERMINE SUCCESS - now considers ALL transports
  const totalReach = result.targetedDrivers + result.availableDrivers + sseAvailableSize + eventBusDriversReached;
  
  if (totalReach > 0) {
    result.success = true;
    logger.info(`[BROADCAST] ✅ SUCCESS: Ride request delivered via hybrid transports (total reach: ${totalReach})`);
  } else {
    result.success = false;
    const error = `P0 FAILURE: Ride ${rideId} broadcast to ZERO drivers across ALL transports! ` +
      `(${driverIds.length} eligible, Socket.io: ${result.connectedDrivers}, EventBus: ${sseAvailableSize})`;
    logger.error(`[BROADCAST] 🚨 ${error}`);
    result.errors.push(error);
    
    logger.error(`[BROADCAST] DIAGNOSTIC: All transports failed.`);
    logger.error(`[BROADCAST]   Socket.io: ${result.connectedDrivers} connected`);
    logger.error(`[BROADCAST]   SSE:       ${sseAvailableSize} connected`);
    logger.error(`[BROADCAST]   EventBus:  ${eventBus.getMetrics().transports.join(', ')} registered`);
    
    if (driverIds.length > 0 && totalReach === 0) {
      logger.error(`[BROADCAST] 🚨 ${driverIds.length} drivers eligible but NONE reachable on ANY transport`);
      result.errors.push(`ALL_TRANSPORTS_UNREACHABLE: ${driverIds.length} eligible, 0 reachable`);
    }
  }
  
  logger.info(`[BROADCAST] ========== RIDE REQUEST BROADCAST END ==========`);
  
  return result;
}

export function broadcastRideStatusUpdate(rideId: string, status: string, data?: any) {
  const timestamp = new Date().toISOString();

  // ── Primary: Broadcast via EventBus (SSE + MQTT + Socket.io) ─────────────
  try {
    eventBus.publish(CHANNELS.ride(rideId), {
      type: 'ride-status-update',
      rideId,
      status,
      data,
      timestamp,
    });
  } catch (error) {
    logger.error('[REALTIME] EventBus publish failed for ride status', { error, rideId, status });
  }

  // ── Also publish via MQTT directly for QoS 1 delivery guarantee ──────────
  try {
    mqttBroker.deliver(CHANNELS.ride(rideId), {
      type: 'ride-status-update',
      rideId,
      status,
      data,
      timestamp,
    });
  } catch (error) {
    logger.error('[REALTIME] MQTT direct deliver failed for ride status', { error, rideId, status });
  }

  // ── Legacy Socket.io broadcast (backward compatibility) ──────────────────
  if (io) {
    try {
      const roomSize = io.sockets.adapter.rooms.get(`ride-${rideId}`)?.size || 0;
      io.to(`ride-${rideId}`).emit('ride-status-update', { rideId, status, data, timestamp });
      logger.info(`[REALTIME] Ride status update broadcast: ride=${rideId}, status=${status}, socketio_room=${roomSize}, eventbus_listeners=${eventBus.getTotalListeners(CHANNELS.ride(rideId))}`);
    } catch (error) {
      logger.error(`[REALTIME] Socket.io broadcast failed for ride status`, { error, rideId, status });
    }
  } else {
    logger.info(`[REALTIME] Ride status update broadcast (SSE/MQTT only): ride=${rideId}, status=${status}`);
  }
}

export function broadcastDriverAssigned(rideId: string, driver: any) {
  const timestamp = new Date().toISOString();

  // ── Primary: EventBus broadcast (SSE + MQTT + Socket.io) ─────────────────
  eventBus.publish(CHANNELS.ride(rideId), {
    type: 'driver-assigned',
    rideId,
    driver,
    timestamp,
  });

  // ── Auto-subscribe driver to ride SSE channel ────────────────────────────
  if (driver?.id) {
    sseManager.subscribeToRide(driver.id, rideId);
  }

  // ── Legacy Socket.io broadcast ───────────────────────────────────────────
  if (io) {
    try {
      const roomSize = io.sockets.adapter.rooms.get(`ride-${rideId}`)?.size || 0;
      io.to(`ride-${rideId}`).emit('driver-assigned', { rideId, driver, timestamp });
      logger.info(`[REALTIME] Driver assigned broadcast: ride=${rideId}, driver=${driver?.id}, socketio_room=${roomSize}`);
    } catch (error) {
      logger.error(`[REALTIME] Socket.io broadcast failed for driver assigned`, { error, rideId });
    }
  } else {
    logger.info(`[REALTIME] Driver assigned broadcast (SSE/MQTT only): ride=${rideId}, driver=${driver?.id}`);
  }
}

export function broadcastRideCancelled(rideId: string, cancelledBy: string, reason?: string) {
  const timestamp = new Date().toISOString();

  // ── Primary: EventBus broadcast (SSE + MQTT + Socket.io) ─────────────────
  eventBus.publish(CHANNELS.ride(rideId), {
    type: 'ride-cancelled',
    rideId,
    cancelledBy,
    reason,
    timestamp,
  });

  // ── Legacy Socket.io broadcast ───────────────────────────────────────────
  if (io) {
    try {
      const roomSize = io.sockets.adapter.rooms.get(`ride-${rideId}`)?.size || 0;
      io.to(`ride-${rideId}`).emit('ride-cancelled', { rideId, cancelledBy, reason, timestamp });
      logger.info(`[REALTIME] Ride cancelled broadcast: ride=${rideId}, by=${cancelledBy}, socketio_room=${roomSize}`);
    } catch (error) {
      logger.error(`[REALTIME] Socket.io broadcast failed for ride cancelled`, { error, rideId });
    }
  } else {
    logger.info(`[REALTIME] Ride cancelled broadcast (SSE/MQTT only): ride=${rideId}, by=${cancelledBy}`);
  }
}

/** Broadcast new chat message to everyone in the ride room (driver + passenger) */
export function broadcastRideChatMessage(rideId: string, message: { id: string; senderId: string; message: string; timestamp: Date }) {
  const timestamp = new Date().toISOString();

  // ── Primary: EventBus broadcast (SSE + MQTT + Socket.io) ─────────────────
  eventBus.publish(CHANNELS.ride(rideId), {
    type: 'ride-chat-message',
    rideId,
    message: {
      id: message.id,
      senderId: message.senderId,
      message: message.message,
      timestamp: message.timestamp.toISOString(),
    },
  });

  // ── Legacy Socket.io broadcast ───────────────────────────────────────────
  if (io) {
    io.to(`ride-${rideId}`).emit('ride-chat-message', {
      rideId,
      message: {
        id: message.id,
        senderId: message.senderId,
        message: message.message,
        timestamp: message.timestamp.toISOString(),
      },
      timestamp,
    });
  }
  logger.debug(`[REALTIME] Chat message broadcast to ride-${rideId} (EventBus + Socket.io)`);
}

/** Broadcast chat read cursor update to everyone in the ride room. */
export function broadcastChatRead(rideId: string, readerId: string, lastReadAt: Date) {
  const readAtIso = lastReadAt.toISOString();

  // ── Primary: EventBus broadcast (SSE + MQTT + Socket.io) ─────────────────
  eventBus.publish(CHANNELS.ride(rideId), {
    type: 'chat-read',
    rideId,
    readerId,
    lastReadAt: readAtIso,
  });

  // ── Legacy Socket.io broadcast ───────────────────────────────────────────
  if (io) {
    io.to(`ride-${rideId}`).emit('chat-read', {
      rideId,
      readerId,
      lastReadAt: readAtIso,
    });
  }
  logger.debug(`[REALTIME] Chat read broadcast to ride-${rideId} by user=${readerId}`);
}

export async function getDriverHeatmapData(): Promise<Array<{ lat: number; lng: number; count: number }>> {
  const drivers = await prisma.driver.findMany({
    where: {
      isOnline: true,
      currentLatitude: { not: null },
      currentLongitude: { not: null },
    },
    select: { currentLatitude: true, currentLongitude: true },
  });
  const map = new Map<string, { lat: number; lng: number; count: number }>();
  drivers.forEach((d) => {
    if (d.currentLatitude != null && d.currentLongitude != null) {
      const lat = Math.round(d.currentLatitude * 1000) / 1000;
      const lng = Math.round(d.currentLongitude * 1000) / 1000;
      const key = `${lat},${lng}`;
      const existing = map.get(key);
      if (existing) existing.count++;
      else map.set(key, { lat, lng, count: 1 });
    }
  });
  return Array.from(map.values());
}

export async function getDemandHotspots(): Promise<Array<{ lat: number; lng: number; demand: number }>> {
  const rides = await prisma.ride.findMany({
    where: {
      status: { in: ['PENDING', 'CONFIRMED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED', 'RIDE_STARTED'] },
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
    select: { pickupLatitude: true, pickupLongitude: true },
  });
  const map = new Map<string, { lat: number; lng: number; demand: number }>();
  rides.forEach((r) => {
    const lat = Math.round(r.pickupLatitude * 1000) / 1000;
    const lng = Math.round(r.pickupLongitude * 1000) / 1000;
    const key = `${lat},${lng}`;
    const existing = map.get(key);
    if (existing) existing.demand++;
    else map.set(key, { lat, lng, demand: 1 });
  });
  return Array.from(map.values()).filter((h) => h.demand >= 2);
}
