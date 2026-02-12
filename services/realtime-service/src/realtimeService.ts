import { prisma, latLngToH3, getH3Config } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import type { Server as SocketServer } from 'socket.io';

const logger = createLogger('realtime-service');
let io: SocketServer | null = null;

// Push notification service configuration
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5006';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';

/**
 * Send push notification for new ride request to a driver
 * Non-blocking - failures are logged but don't affect the main broadcast
 */
async function sendRideRequestPushNotification(
  driverId: string,
  rideId: string,
  rideData: { pickupAddress: string; totalFare: number; distance: number }
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

    const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications/internal/ride-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        userId: driver.userId,
        event: 'NEW_RIDE_REQUEST',
        rideId,
        eventData: {
          pickupAddress: rideData.pickupAddress,
          estimatedFare: rideData.totalFare,
          distance: rideData.distance,
        },
      }),
    });

    if (response.ok) {
      const result = await response.json();
      if (result.success) {
        logger.info(`[PUSH] Sent NEW_RIDE_REQUEST to driver ${driverId}`);
      }
    }
  } catch (error) {
    logger.warn(`[PUSH] Failed to send ride request push to driver ${driverId}`, { error });
    // Non-blocking - continue with socket broadcast
  }
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
  
  await prisma.driver.update({
    where: { id: driverId },
    data: { 
      currentLatitude: lat, 
      currentLongitude: lng, 
      h3Index,  // Store H3 index for geospatial matching
      lastActiveAt: new Date() 
    },
  });
  
  logger.debug(`[H3] Driver ${driverId} location updated: h3Index=${h3Index}, res=${config.resolution}`);
  
  if (io) {
    io.emit('driver-location-update', {
      driverId,
      lat,
      lng,
      h3Index,  // Include H3 index in event for debugging
      heading,
      speed,
      timestamp: new Date().toISOString(),
    });
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
    
    if (vehicleType) {
      whereClause.vehicleType = vehicleType;
    }
    
    const drivers = await prisma.driver.findMany({
      where: whereClause,
      select: { id: true, currentLatitude: true, currentLongitude: true },
    });
    
    // Filter by actual distance
    const nearbyDrivers = drivers.filter(d => {
      if (!d.currentLatitude || !d.currentLongitude) return false;
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
  
  logger.debug(`[H3-REALTIME] No drivers found after k=${h3Config.maxKRing}`);
  return [];
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
        
        // Send push notification as fallback for drivers not connected to socket
        // This ensures drivers with app in background still get notified
        sendRideRequestPushNotification(driverId, rideId, {
          pickupAddress: rideData.pickupAddress,
          totalFare: rideData.totalFare,
          distance: rideData.distance,
        }).catch(err => logger.warn(`[PUSH] Push fallback failed for ${driverId}`, { error: err }));
        
        // P0 INCONSISTENCY: Driver is in DB as online but not connected to socket
        if (isTracked) {
          logger.error(`[BROADCAST]   🚨 P0 INCONSISTENCY: Driver ${driverId} is tracked but room is empty!`);
          result.errors.push(`Driver ${driverId} tracked but not in room`);
        }
      }
    });
  }
  
  // STEP 2: Broadcast to all available drivers room as fallback
  const availableDriversRoom = io.sockets.adapter.rooms.get('available-drivers');
  result.availableDrivers = availableDriversRoom?.size || 0;
  
  logger.info(`[BROADCAST] Step 2: Broadcasting to available-drivers room (${result.availableDrivers} sockets)`);
  
  if (result.availableDrivers > 0) {
    io.to('available-drivers').emit('new-ride-request', payload);
    logger.info(`[BROADCAST]   ✅ EMITTED to available-drivers room`);
  } else {
    logger.warn(`[BROADCAST]   ⚠️ available-drivers room is EMPTY`);
  }
  
  // SUMMARY
  logger.info(`[BROADCAST] ========== BROADCAST SUMMARY ==========`);
  logger.info(`[BROADCAST] Ride ID: ${rideId}`);
  logger.info(`[BROADCAST] Targeted drivers (from nearby): ${result.targetedDrivers}/${driverIds.length}`);
  logger.info(`[BROADCAST] Drivers emitted to: ${JSON.stringify(driversEmitted)}`);
  logger.info(`[BROADCAST] Drivers NOT connected: ${JSON.stringify(driversNotConnected)}`);
  logger.info(`[BROADCAST] Available drivers room: ${result.availableDrivers}`);
  logger.info(`[BROADCAST] Total unique connected drivers: ${result.connectedDrivers}`);
  
  // DETERMINE SUCCESS
  if (result.targetedDrivers > 0 || result.availableDrivers > 0) {
    result.success = true;
    logger.info(`[BROADCAST] ✅ SUCCESS: Ride request broadcast to at least one driver`);
  } else {
    result.success = false;
    const error = `P0 FAILURE: Ride ${rideId} broadcast to ZERO drivers! ` +
      `(${driverIds.length} eligible, ${driversNotConnected.length} not connected, ` +
      `${result.connectedDrivers} total connected)`;
    logger.error(`[BROADCAST] 🚨 ${error}`);
    result.errors.push(error);
    
    // Log additional diagnostic info
    logger.error(`[BROADCAST] DIAGNOSTIC: This means either:`);
    logger.error(`[BROADCAST]   1. No drivers are online in the app`);
    logger.error(`[BROADCAST]   2. Drivers are online but not connected to Socket.io`);
    logger.error(`[BROADCAST]   3. Drivers connected with wrong ID (userId vs driverId)`);
    logger.error(`[BROADCAST]   4. Socket connection dropped and not reconnected`);
    
    // P0 INCONSISTENCY CHECK: If there are eligible drivers but none connected
    if (driverIds.length > 0 && result.connectedDrivers === 0) {
      logger.error(`[BROADCAST] 🚨🚨🚨 P0 INCONSISTENCY DETECTED 🚨🚨🚨`);
      logger.error(`[BROADCAST] ${driverIds.length} drivers are ELIGIBLE (online in DB) but ZERO are connected to Socket.io`);
      logger.error(`[BROADCAST] This is a critical state mismatch that MUST be investigated`);
      result.errors.push(`P0_INCONSISTENCY: ${driverIds.length} eligible drivers but 0 socket connections`);
    }
    
    // If drivers are connected but not in the eligible list
    if (driverIds.length === 0 && result.connectedDrivers > 0) {
      logger.error(`[BROADCAST] 🚨 MISMATCH: ${result.connectedDrivers} drivers connected to socket but NONE are eligible`);
      logger.error(`[BROADCAST] Check: Are connected drivers isOnline=true in DB? Do they have valid locations?`);
      result.errors.push(`ELIGIBILITY_MISMATCH: ${result.connectedDrivers} connected but 0 eligible`);
    }
  }
  
  logger.info(`[BROADCAST] ========== RIDE REQUEST BROADCAST END ==========`);
  
  return result;
}

export function broadcastRideStatusUpdate(rideId: string, status: string, data?: any) {
  if (!io) {
    logger.warn(`[REALTIME] Cannot broadcast ride status update - Socket.io not initialized`);
    return;
  }
  try {
    const roomSize = io.sockets.adapter.rooms.get(`ride-${rideId}`)?.size || 0;
    io.to(`ride-${rideId}`).emit('ride-status-update', { rideId, status, data, timestamp: new Date().toISOString() });
    logger.info(`[REALTIME] Broadcast ride status update: ride=${rideId}, status=${status}, room_size=${roomSize}`);
  } catch (error) {
    logger.error(`[REALTIME] Failed to broadcast ride status update`, { error, rideId, status });
  }
}

export function broadcastDriverAssigned(rideId: string, driver: any) {
  if (!io) {
    logger.warn(`[REALTIME] Cannot broadcast driver assigned - Socket.io not initialized`);
    return;
  }
  try {
    const roomSize = io.sockets.adapter.rooms.get(`ride-${rideId}`)?.size || 0;
    io.to(`ride-${rideId}`).emit('driver-assigned', { rideId, driver, timestamp: new Date().toISOString() });
    logger.info(`[REALTIME] Broadcast driver assigned: ride=${rideId}, driver=${driver?.id}, room_size=${roomSize}`);
  } catch (error) {
    logger.error(`[REALTIME] Failed to broadcast driver assigned`, { error, rideId, driverId: driver?.id });
  }
}

export function broadcastRideCancelled(rideId: string, cancelledBy: string, reason?: string) {
  if (!io) {
    logger.warn(`[REALTIME] Cannot broadcast ride cancelled - Socket.io not initialized`);
    return;
  }
  try {
    const roomSize = io.sockets.adapter.rooms.get(`ride-${rideId}`)?.size || 0;
    io.to(`ride-${rideId}`).emit('ride-cancelled', { rideId, cancelledBy, reason, timestamp: new Date().toISOString() });
    logger.info(`[REALTIME] Broadcast ride cancelled: ride=${rideId}, by=${cancelledBy}, room_size=${roomSize}`);
  } catch (error) {
    logger.error(`[REALTIME] Failed to broadcast ride cancelled`, { error, rideId, cancelledBy });
  }
}

/** Broadcast new chat message to everyone in the ride room (driver + passenger) */
export function broadcastRideChatMessage(rideId: string, message: { id: string; senderId: string; message: string; timestamp: Date }) {
  if (!io) return;
  io.to(`ride-${rideId}`).emit('ride-chat-message', {
    rideId,
    message: {
      id: message.id,
      senderId: message.senderId,
      message: message.message,
      timestamp: message.timestamp.toISOString(),
    },
    timestamp: new Date().toISOString(),
  });
  logger.debug(`[REALTIME] Chat message broadcast to ride-${rideId}`);
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
