import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, optionalAuth, authenticate, AuthRequest, errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import { canDriverStartRides, COMPLETED_ONBOARDING_STATUS } from '@raahi/shared';
import {
  setIo,
  setDriverMaps,
  getRealTimeStats,
  getLocationStats,
  updateDriverLocation,
  getDriverHeatmapData,
  getDemandHotspots,
  broadcastRideRequest,
  broadcastRideStatusUpdate,
  broadcastDriverAssigned,
  broadcastRideCancelled,
  broadcastRideChatMessage,
} from './realtimeService';

// Hybrid real-time transport imports
import { eventBus } from './eventBus';
import { sseManager } from './sseManager';
import { mqttBroker } from './mqttBroker';
import { socketTransport } from './socketTransport';
import { negotiateEncoding, encodeLocation, getContentType, CompactJsonCodec, BinaryLocationCodec } from './binaryProtocol';

// In-memory state stores (Fireball + RAMEN)
import { rideStateStore } from './rideStateStore';
import { driverStateStore } from './driverStateStore';
import { initializeStateSync, shutdownStateSync } from './stateSync';

const logger = createLogger('realtime-service');
const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 5007;

// Internal service authentication middleware
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';

const authenticateInternal = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = req.headers['x-internal-api-key'] as string;
  const forwardedFor = req.headers['x-forwarded-for'] as string;
  const remoteAddress = req.connection?.remoteAddress || req.socket?.remoteAddress;
  
  // Allow requests from localhost/internal network or with valid API key
  const isLocalRequest = remoteAddress?.includes('127.0.0.1') || 
                         remoteAddress?.includes('::1') || 
                         remoteAddress?.includes('172.') ||
                         remoteAddress?.includes('10.') ||
                         !forwardedFor;
  
  if (apiKey === INTERNAL_API_KEY || isLocalRequest) {
    next();
    return;
  }
  
  logger.warn(`[AUTH] Unauthorized internal API access attempt from ${remoteAddress}`);
  res.status(401).json({ success: false, message: 'Unauthorized - Internal API access only' });
};

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
  // Increase ping timeout for real devices with poor connectivity
  pingTimeout: 60000,
  pingInterval: 25000,
});
setIo(io);

// Track connected drivers - EXPORTED to realtimeService for broadcast verification
const connectedDrivers = new Map<string, string>(); // socketId -> driverId
const driverSockets = new Map<string, Set<string>>(); // driverId -> Set of socketIds (for multi-device)
const userIdToDriverId = new Map<string, string>(); // userId -> driverId (for ID translation)

// Share maps with realtimeService for broadcast verification
setDriverMaps(connectedDrivers, driverSockets);

// Initialize Socket.io transport adapter for EventBus integration
socketTransport.initialize(io, connectedDrivers, driverSockets);

// Heartbeat configuration for stale connection detection
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds

io.on('connection', (socket) => {
  logger.info(`[SOCKET] Client connected: ${socket.id}`);
  
  // Track last activity for stale connection detection
  let lastActivity = Date.now();
  let currentDriverId: string | null = null;
  
  // Update activity timestamp on any event
  const updateActivity = () => {
    lastActivity = Date.now();
  };
  
  /**
   * CRITICAL FIX: Helper to resolve userId to driverId
   * Flutter app sends userId (from JWT), but we need driverId for rooms
   */
  const resolveDriverId = async (inputId: string): Promise<string | null> => {
    // Check if it's already a driverId we know about
    if (driverSockets.has(inputId)) {
      return inputId;
    }
    
    // Check cache first
    if (userIdToDriverId.has(inputId)) {
      return userIdToDriverId.get(inputId)!;
    }
    
    // Look up in database - inputId might be a userId
    try {
      const driver = await prisma.driver.findFirst({
        where: {
          OR: [
            { id: inputId },      // It's already a driverId
            { userId: inputId },  // It's a userId, need to get driverId
          ],
        },
        select: { id: true, userId: true },
      });
      
      if (driver) {
        // Cache the mapping
        userIdToDriverId.set(driver.userId, driver.id);
        logger.info(`[SOCKET] Resolved driver: userId=${driver.userId} -> driverId=${driver.id}`);
        return driver.id;
      }
      
      logger.warn(`[SOCKET] No driver found for ID: ${inputId}`);
      return null;
    } catch (error) {
      logger.error(`[SOCKET] Error resolving driver ID: ${inputId}`, { error });
      return null;
    }
  };
  
  /**
   * CRITICAL FIX: Register driver with proper ID resolution, room joining, and DB verification
   */
  const registerDriver = async (inputId: string, eventName: string) => {
    logger.info(`[SOCKET] ========== DRIVER REGISTRATION START ==========`);
    logger.info(`[SOCKET] Input ID: ${inputId}, Event: ${eventName}, Socket: ${socket.id}`);
    
    const driverId = await resolveDriverId(inputId);
    
    if (!driverId) {
      logger.error(`[SOCKET] ❌ FAILED to register driver - could not resolve ID: ${inputId} (event: ${eventName})`);
      socket.emit('registration-error', { 
        message: 'Invalid driver ID - not found in database',
        inputId,
        eventName,
      });
      return null;
    }
    
    // CRITICAL: Verify driver is actually online in DB
    const dbDriver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true, userId: true, isOnline: true, isActive: true, isVerified: true, onboardingStatus: true, currentLatitude: true, currentLongitude: true },
    });
    
    if (!dbDriver) {
      logger.error(`[SOCKET] ❌ Driver ${driverId} not found in DB during registration`);
      socket.emit('registration-error', { 
        message: 'Driver not found in database',
        driverId,
        eventName,
      });
      return null;
    }
    
    // Log DB state for debugging
    logger.info(`[SOCKET] DB State: isOnline=${dbDriver.isOnline}, isActive=${dbDriver.isActive}, isVerified=${dbDriver.isVerified}, onboardingStatus=${dbDriver.onboardingStatus}`);
    logger.info(`[SOCKET] DB Location: (${dbDriver.currentLatitude}, ${dbDriver.currentLongitude})`);
    
    // CRITICAL: Enforce driver verification before allowing socket registration
    if (!canDriverStartRides(dbDriver)) {
      logger.error(`[SOCKET] ❌ Driver ${driverId} NOT VERIFIED - blocking socket registration (isActive=${dbDriver.isActive}, isVerified=${dbDriver.isVerified}, onboardingStatus=${dbDriver.onboardingStatus})`);
      socket.emit('registration-error', { 
        message: 'Driver not verified',
        code: 'DRIVER_NOT_VERIFIED',
        driverId,
        eventName,
        verificationState: {
          isActive: dbDriver.isActive,
          isVerified: dbDriver.isVerified,
          onboardingStatus: dbDriver.onboardingStatus,
        },
      });
      socket.disconnect(true);
      return null;
    }
    
    // CRITICAL: Check for DB/Socket state mismatch
    if (!dbDriver.isOnline) {
      logger.warn(`[SOCKET] ⚠️ P0 WARNING: Driver ${driverId} connecting to socket but DB isOnline=FALSE`);
      logger.warn(`[SOCKET] This may cause ride broadcasts to fail - driver should call PATCH /api/driver/status first`);
      // Still allow connection but warn - the driver app should sync state
      socket.emit('state-warning', {
        message: 'Your online status in database is FALSE. Please update your status.',
        driverId,
        dbIsOnline: false,
        recommendation: 'Call PATCH /api/driver/status with online=true',
      });
    }
    
    // Store current driver ID for this socket
    currentDriverId = driverId;
    
    // Join driver-specific room
    socket.join(`driver-${driverId}`);
    
    // Join available-drivers room
    socket.join('available-drivers');
    
    // Track in maps
    connectedDrivers.set(socket.id, driverId);
    
    if (!driverSockets.has(driverId)) {
      driverSockets.set(driverId, new Set());
    }
    driverSockets.get(driverId)!.add(socket.id);
    
    // Verify registration - MUST succeed
    const driverRoom = io.sockets.adapter.rooms.get(`driver-${driverId}`);
    const availableRoom = io.sockets.adapter.rooms.get('available-drivers');
    
    const inDriverRoom = driverRoom?.has(socket.id) || false;
    const inAvailableRoom = availableRoom?.has(socket.id) || false;
    
    if (!inDriverRoom || !inAvailableRoom) {
      logger.error(`[SOCKET] 🚨 P0 ERROR: Room join verification FAILED!`);
      logger.error(`[SOCKET]   - In driver-${driverId} room: ${inDriverRoom}`);
      logger.error(`[SOCKET]   - In available-drivers room: ${inAvailableRoom}`);
      socket.emit('registration-error', { 
        message: 'Failed to join required rooms',
        driverId,
        inDriverRoom,
        inAvailableRoom,
      });
      return null;
    }
    
    // Register driver transport in RAMEN
    await driverStateStore.addTransport(driverId, 'socketio');
    
    // Ensure driver is registered in RAMEN (if not already from hydration)
    if (!(await driverStateStore.getDriver(driverId))) {
      await driverStateStore.registerDriver({
        id: driverId,
        userId: dbDriver.userId,
        isOnline: dbDriver.isOnline,
        isActive: dbDriver.isActive,
        isVerified: dbDriver.isVerified,
        currentLatitude: dbDriver.currentLatitude,
        currentLongitude: dbDriver.currentLongitude,
        h3Index: null,
        firstName: '',
        lastName: '',
        phone: null,
        profileImage: null,
        vehicleNumber: null,
        vehicleModel: null,
        vehicleType: null,
        rating: 0,
        ratingCount: 0,
        totalRides: 0,
      });
    }
    
    logger.info(`[SOCKET] ✅ Driver REGISTERED SUCCESSFULLY`);
    logger.info(`[SOCKET]   - Driver ID: ${driverId}`);
    logger.info(`[SOCKET]   - Socket ID: ${socket.id}`);
    logger.info(`[SOCKET]   - In driver-${driverId} room: ${inDriverRoom} (size: ${driverRoom?.size})`);
    logger.info(`[SOCKET]   - In available-drivers room: ${inAvailableRoom} (size: ${availableRoom?.size})`);
    logger.info(`[SOCKET]   - DB isOnline: ${dbDriver.isOnline}`);
    logger.info(`[SOCKET]   - RAMEN registered: true`);
    logger.info(`[SOCKET] ========== DRIVER REGISTRATION COMPLETE ==========`);
    
    // Confirm registration to client with full state
    socket.emit('registration-success', {
      driverId,
      socketId: socket.id,
      rooms: [`driver-${driverId}`, 'available-drivers'],
      dbState: {
        isOnline: dbDriver.isOnline,
        isActive: dbDriver.isActive,
        isVerified: dbDriver.isVerified,
        hasLocation: dbDriver.currentLatitude != null && dbDriver.currentLongitude != null,
      },
      timestamp: new Date().toISOString(),
    });
    
    return driverId;
  };
  
  // Heartbeat mechanism
  socket.on('ping', () => {
    updateActivity();
    socket.emit('pong', { timestamp: Date.now() });
  });
  
  // Join ride room for passengers/drivers tracking a specific ride
  socket.on('join-ride', (rideId: string) => {
    if (!rideId || typeof rideId !== 'string') return;
    updateActivity();
    socket.join(`ride-${rideId}`);
    logger.debug(`[SOCKET] Socket ${socket.id} joined ride room: ride-${rideId}`);
  });
  
  socket.on('leave-ride', (rideId: string) => {
    if (!rideId || typeof rideId !== 'string') return;
    updateActivity();
    socket.leave(`ride-${rideId}`);
    logger.debug(`[SOCKET] Socket ${socket.id} left ride room: ride-${rideId}`);
  });
  
  // Driver joins their personal room to receive ride requests
  // CRITICAL: Accepts both userId and driverId
  socket.on('join-driver', async (inputId: string) => {
    if (!inputId || typeof inputId !== 'string') {
      logger.warn(`[SOCKET] join-driver called with invalid ID: ${inputId}`);
      return;
    }
    updateActivity();
    await registerDriver(inputId, 'join-driver');
  });
  
  socket.on('leave-driver', async (inputId: string) => {
    if (!inputId || typeof inputId !== 'string') return;
    updateActivity();
    
    const driverId = await resolveDriverId(inputId);
    if (!driverId) return;
    
    socket.leave(`driver-${driverId}`);
    socket.leave('available-drivers');
    connectedDrivers.delete(socket.id);
    
    // Remove from multi-device tracking
    const sockets = driverSockets.get(driverId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        driverSockets.delete(driverId);
      }
    }
    
    currentDriverId = null;
    logger.info(`[SOCKET] Driver ${driverId} left driver room (socket: ${socket.id})`);
  });
  
  // Driver goes online - join available drivers room
  // CRITICAL: Accepts both userId and driverId
  socket.on('driver-online', async (inputId: string) => {
    if (!inputId || typeof inputId !== 'string') {
      logger.warn(`[SOCKET] driver-online called with invalid ID: ${inputId}`);
      return;
    }
    updateActivity();
    await registerDriver(inputId, 'driver-online');
  });
  
  // Driver goes offline - leave available drivers room
  socket.on('driver-offline', async (inputId: string) => {
    if (!inputId || typeof inputId !== 'string') return;
    updateActivity();
    
    const driverId = await resolveDriverId(inputId);
    if (driverId) {
      socket.leave('available-drivers');
      logger.info(`[SOCKET] Driver ${driverId} is now offline`);
    }
  });
  
  // Driver accepts a ride request (real-time notification)
  socket.on('accept-ride-request', (data: { rideId: string; driverId: string }) => {
    if (!data.rideId || !data.driverId) return;
    if (typeof data.rideId !== 'string' || typeof data.driverId !== 'string') return;
    updateActivity();
    
    // Notify the ride room (passenger) that ride was accepted
    io.to(`ride-${data.rideId}`).emit('ride-accepted', {
      rideId: data.rideId,
      driverId: data.driverId,
      timestamp: new Date().toISOString(),
    });
    
    // Notify all available drivers that this ride is taken (including sender for consistency)
    io.to('available-drivers').emit('ride-taken', {
      rideId: data.rideId,
      driverId: data.driverId,
      timestamp: new Date().toISOString(),
    });
    
    logger.info(`Ride ${data.rideId} accepted by driver ${data.driverId}`);
  });
  
  // Driver arrived at pickup location
  socket.on('driver-arrived', (data: { rideId: string; driverId: string }) => {
    if (!data.rideId || !data.driverId) return;
    if (typeof data.rideId !== 'string' || typeof data.driverId !== 'string') return;
    updateActivity();
    
    io.to(`ride-${data.rideId}`).emit('driver-arrived', {
      rideId: data.rideId,
      driverId: data.driverId,
      timestamp: new Date().toISOString(),
    });
    logger.info(`Driver ${data.driverId} arrived for ride ${data.rideId}`);
  });
  
  // Driver location update during ride — uses RAMEN + Fireball (no DB writes)
  socket.on('location-update', async (data: { rideId: string; lat: number; lng: number; heading?: number; speed?: number }) => {
    if (!data.rideId || typeof data.rideId !== 'string') return;
    if (typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
    updateActivity();
    
    // Update ride location in Fireball (in-memory, instant push to ride subscribers)
    await rideStateStore.updateRideLocation(data.rideId, data.lat, data.lng, data.heading, data.speed);
    
    // Update driver location in RAMEN (in-memory H3 index, async DB write)
    if (currentDriverId) {
      await driverStateStore.updateLocation(currentDriverId, data.lat, data.lng, data.heading, data.speed);
    }
    
    // Legacy Socket.io broadcast (backward compatibility)
    io.to(`ride-${data.rideId}`).emit('driver-location', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  });
  
  socket.on('disconnect', async (reason) => {
    const driverId = connectedDrivers.get(socket.id);
    if (driverId) {
      connectedDrivers.delete(socket.id);
      
      // Remove from multi-device tracking
      const sockets = driverSockets.get(driverId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          driverSockets.delete(driverId);
          // Remove Socket.io transport from RAMEN
          await driverStateStore.removeTransport(driverId, 'socketio');
          logger.warn(`[SOCKET] ⚠️ Driver ${driverId} FULLY DISCONNECTED (no remaining sockets) - reason: ${reason}`);
        } else {
          logger.info(`[SOCKET] Driver ${driverId} disconnected one socket, ${sockets.size} remaining (socket: ${socket.id}, reason: ${reason})`);
        }
      }
    } else {
      logger.info(`[SOCKET] Client disconnected: ${socket.id} (reason: ${reason})`);
    }
  });
  
  // Handle connection errors
  socket.on('error', (error) => {
    logger.error(`Socket error for ${socket.id}`, { error: error.message });
  });
  
  // Debug: Get connected drivers count
  socket.on('get-stats', () => {
    updateActivity();
    socket.emit('stats', {
      connectedDrivers: connectedDrivers.size,
      uniqueDrivers: driverSockets.size,
      availableDriversRoom: io.sockets.adapter.rooms.get('available-drivers')?.size || 0,
      totalConnections: io.sockets.sockets.size,
    });
  });
});

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'realtime-service',
    timestamp: new Date().toISOString(),
    transports: {
      socketio: socketTransport.isHealthy() ? 'healthy' : 'down',
      sse: sseManager.isHealthy() ? 'healthy' : 'down',
      mqtt: mqttBroker.isHealthy() ? 'healthy' : 'down',
    },
    eventBus: eventBus.getMetrics(),
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SSE (Server-Sent Events) Endpoints
// 
// Primary real-time protocol for server→client push communication.
// Replaces Socket.io for ride status updates, driver location tracking,
// and notifications. Uses standard HTTP - no connection upgrade needed.
//
// Endpoints:
//   GET /api/realtime/sse/ride/:rideId    - Ride events stream (passenger/driver)
//   GET /api/realtime/sse/driver/:driverId - Driver events stream (ride requests, assignments)
//   GET /api/realtime/sse/admin            - Admin monitoring stream
//   GET /api/realtime/sse/stats            - SSE connection stats
// ════════════════════════════════════════════════════════════════════════════════

/**
 * SSE: Ride Events Stream
 * 
 * Subscribe to real-time events for a specific ride:
 * - ride-status-update: Status changes (CONFIRMED, DRIVER_ARRIVED, RIDE_STARTED, etc.)
 * - driver-location: Driver's real-time location during the ride
 * - driver-assigned: When a driver accepts the ride
 * - ride-cancelled: When the ride is cancelled
 * - ride-chat-message: In-ride chat messages
 * 
 * Usage (Flutter):
 *   final eventSource = EventSource(
 *     '/api/realtime/sse/ride/$rideId',
 *     headers: {'Authorization': 'Bearer $token'}
 *   );
 *   eventSource.addEventListener('ride-status-update', (event) { ... });
 *   eventSource.addEventListener('driver-location', (event) { ... });
 * 
 * Auto-reconnection: Built-in via Last-Event-ID header
 */
app.get('/api/realtime/sse/ride/:rideId', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const rideId = req.params.rideId;
  const userId = req.user!.id;

  // Verify the user is a participant in this ride
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { id: true, passengerId: true, driverId: true, status: true },
  });

  if (!ride) {
    res.status(404).json({ success: false, message: 'Ride not found' });
    return;
  }

  // Check if user is passenger or driver
  let isParticipant = ride.passengerId === userId;
  if (!isParticipant && ride.driverId) {
    const driver = await prisma.driver.findUnique({
      where: { userId },
      select: { id: true },
    });
    isParticipant = driver?.id === ride.driverId;
  }

  if (!isParticipant) {
    res.status(403).json({ success: false, message: 'Access denied - not a participant of this ride' });
    return;
  }

  logger.info(`[SSE] Ride stream requested: ride=${rideId}, user=${userId}`);
  sseManager.handleRideConnection(req, res, rideId, userId);
}));

/**
 * SSE: Driver Events Stream
 * 
 * Subscribe to real-time events for a driver:
 * - new-ride-request: New ride requests in the driver's area (H3 cell-scoped)
 * - driver-assigned: Confirmation when driver is assigned to a ride
 * - ride-cancelled: When an accepted ride is cancelled
 * - ride-taken: When a ride request was taken by another driver
 * 
 * Query params:
 *   lat, lng: Current driver location (for H3 cell subscription)
 * 
 * H3 Integration:
 *   The driver's lat/lng is converted to an H3 cell index, and the SSE
 *   connection subscribes to that cell plus adjacent cells (kRing=1).
 *   When the driver moves, call PATCH /api/realtime/sse/driver/:driverId/location
 *   to update H3 subscriptions.
 */
app.get('/api/realtime/sse/driver/:driverId', authenticate, [
  query('lat').optional().isFloat({ min: -90, max: 90 }),
  query('lng').optional().isFloat({ min: -180, max: 180 }),
], asyncHandler(async (req: AuthRequest, res: Response) => {
  const inputDriverId = req.params.driverId;
  const userId = req.user!.id;

  // Resolve driver ID (supports both userId and driverId)
  const driver = await prisma.driver.findFirst({
    where: {
      OR: [{ id: inputDriverId }, { userId: inputDriverId }, { userId }],
    },
    select: { id: true, userId: true, isActive: true, isOnline: true },
  });

  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  if (driver.userId !== userId) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  if (!driver.isActive) {
    res.status(403).json({ success: false, message: 'Driver account is not active' });
    return;
  }

  const lat = req.query.lat ? parseFloat(req.query.lat as string) : undefined;
  const lng = req.query.lng ? parseFloat(req.query.lng as string) : undefined;

  logger.info(`[SSE] Driver stream requested: driver=${driver.id}, lat=${lat}, lng=${lng}`);
  sseManager.handleDriverConnection(req, res, driver.id, lat, lng);
}));

/**
 * SSE: Update Driver H3 Cell
 * 
 * When a driver moves to a new H3 cell, update their SSE subscriptions
 * so they receive ride requests for the new area.
 * 
 * This is called periodically by the driver app alongside location updates.
 */
app.patch('/api/realtime/sse/driver/:driverId/location', authenticate, [
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
], asyncHandler(async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, errors: errors.array() });
    return;
  }

  const { lat, lng } = req.body;
  const inputDriverId = req.params.driverId;

  const driver = await prisma.driver.findFirst({
    where: {
      OR: [{ id: inputDriverId }, { userId: inputDriverId }, { userId: req.user!.id }],
    },
    select: { id: true, userId: true },
  });

  if (!driver || driver.userId !== req.user!.id) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const { latLngToH3 } = await import('@raahi/shared');
  const h3Index = latLngToH3(lat, lng);
  sseManager.updateDriverH3(driver.id, h3Index);

  res.status(200).json({ success: true, h3Index });
}));

/**
 * SSE: Admin Monitoring Stream
 * 
 * Subscribe to global real-time events for admin dashboards:
 * - driver-location-update: All driver location updates
 * - ride-status-update: All ride status changes
 */
app.get('/api/realtime/sse/admin', optionalAuth, asyncHandler(async (req: AuthRequest, res: Response) => {
  const userId = req.user?.id || 'anonymous-admin';
  logger.info(`[SSE] Admin stream requested: user=${userId}`);
  sseManager.handleAdminConnection(req, res, userId);
}));

/**
 * SSE: Connection Stats (for monitoring)
 */
app.get('/api/realtime/sse/stats', optionalAuth, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      sse: sseManager.getStats(),
      mqtt: mqttBroker.getStats(),
      socketio: socketTransport.getStats(),
      eventBus: eventBus.getMetrics(),
    },
  });
}));

/**
 * SSE: Detailed connection debug endpoint
 */
app.get('/api/realtime/sse/debug', asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      sseConnections: sseManager.getDetailedConnections(),
      sseStats: sseManager.getStats(),
      mqttStats: mqttBroker.getStats(),
      eventBusMetrics: eventBus.getMetrics(),
    },
  });
}));

// ════════════════════════════════════════════════════════════════════════════════
// Binary Protocol Endpoints (gRPC-style efficient encoding)
//
// For bandwidth-constrained environments (2G/3G networks in India).
// Supports three encoding formats:
//   - binary (application/octet-stream): 24 bytes per location (~80% smaller)
//   - compact-json (application/x-raahi-compact): ~50% smaller than JSON
//   - json (application/json): Standard format (default)
//
// Content negotiation via Accept header.
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Binary/Compact location update endpoint.
 * Supports content negotiation for optimal encoding.
 * 
 * POST /api/realtime/location/binary
 * Content-Type: application/octet-stream | application/x-raahi-compact | application/json
 * Accept: application/octet-stream | application/x-raahi-compact | application/json
 */
app.post('/api/realtime/location/binary',
  optionalAuth,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const contentType = req.headers['content-type'] || 'application/json';
    
    let driverId: string;
    let lat: number;
    let lng: number;
    let heading: number | undefined;
    let speed: number | undefined;
    let h3Index: string | undefined;

    if (contentType.includes('application/octet-stream')) {
      // Binary payload
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const buf = Buffer.concat(chunks);
      const decoded = BinaryLocationCodec.decode(buf);
      lat = decoded.lat;
      lng = decoded.lng;
      heading = decoded.heading;
      speed = decoded.speed;
      driverId = decoded.driverId || '';
    } else if (contentType.includes('application/x-raahi-compact')) {
      // Compact JSON
      const decoded = CompactJsonCodec.decode(req.body);
      lat = decoded.lat;
      lng = decoded.lng;
      heading = decoded.heading;
      speed = decoded.speed;
      driverId = decoded.driverId || '';
    } else {
      // Standard JSON
      lat = req.body.lat;
      lng = req.body.lng;
      heading = req.body.heading;
      speed = req.body.speed;
      driverId = req.body.driverId || '';
    }

    if (!driverId) {
      res.status(400).json({ success: false, message: 'driverId required' });
      return;
    }

    await updateDriverLocation(driverId, lat, lng, heading, speed);

    // Also publish via MQTT for direct subscribers
    const { latLngToH3 } = await import('@raahi/shared');
    h3Index = latLngToH3(lat, lng);
    mqttBroker.publishDriverLocation(driverId, lat, lng, h3Index, heading, speed);

    // Respond in requested format
    const responseFormat = negotiateEncoding(req.headers.accept);
    res.setHeader('Content-Type', getContentType(responseFormat));
    res.status(200).json({ success: true });
  })
);

// ════════════════════════════════════════════════════════════════════════════════
// Protocol Selection Guide (sent as response header for client discovery)
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/realtime/protocols', (req, res) => {
  res.json({
    success: true,
    data: {
      recommended: 'sse',
      available: [
        {
          protocol: 'sse',
          description: 'Server-Sent Events (recommended for most use cases)',
          endpoints: {
            rideEvents: '/api/realtime/sse/ride/:rideId',
            driverEvents: '/api/realtime/sse/driver/:driverId',
            admin: '/api/realtime/sse/admin',
          },
          bestFor: 'Ride status updates, driver assignment, push notifications',
          directionality: 'server → client',
          advantages: ['Auto-reconnect', 'Works through all proxies', 'No connection upgrade needed'],
        },
        {
          protocol: 'mqtt',
          description: 'MQTT over WebSocket (for unreliable networks)',
          endpoints: {
            ws: `ws://localhost:${process.env.MQTT_WS_PORT || 8883}`,
            tcp: `mqtt://localhost:${process.env.MQTT_TCP_PORT || 1883}`,
          },
          topics: {
            driverLocation: 'raahi/driver/{driverId}/location',
            rideStatus: 'raahi/ride/{rideId}/status',
            rideLocation: 'raahi/ride/{rideId}/location',
            rideChat: 'raahi/ride/{rideId}/chat',
            h3RideRequests: 'raahi/h3/{h3Index}/requests',
          },
          bestFor: 'Driver location streaming, poor network conditions',
          directionality: 'bidirectional',
          advantages: ['2-byte overhead', 'Offline queuing', 'Works on 2G/3G'],
        },
        {
          protocol: 'socketio',
          description: 'Socket.io (legacy, maintained for backward compatibility)',
          endpoints: {
            connect: '/socket.io',
          },
          bestFor: 'Existing clients not yet migrated',
          directionality: 'bidirectional',
          status: 'deprecated - migrate to SSE or MQTT',
        },
        {
          protocol: 'binary',
          description: 'Binary protocol for location updates (gRPC-style)',
          endpoints: {
            update: 'POST /api/realtime/location/binary',
          },
          contentTypes: [
            'application/octet-stream (24 bytes, ~80% smaller)',
            'application/x-raahi-compact+json (~50% smaller)',
            'application/json (standard)',
          ],
          bestFor: 'Bandwidth-constrained environments',
        },
      ],
      h3Integration: {
        description: 'All protocols support H3 hexagonal geospatial indexing',
        features: [
          'SSE: Drivers auto-subscribe to H3 cell channels',
          'MQTT: Topics scoped by H3 cell (raahi/h3/{h3Index}/requests)',
          'Socket.io: Ride requests broadcast to H3-matched drivers',
          'Binary: H3 index included in compact location payload',
        ],
      },
    },
  });
});

// Internal API for ride-service (protected by internal authentication)
app.post('/internal/broadcast-ride-request', authenticateInternal, express.json(), asyncHandler(async (req, res) => {
  const { rideId, rideData, driverIds } = req.body;
  if (!rideId || !rideData || !Array.isArray(driverIds)) {
    res.status(400).json({ success: false, message: 'rideId, rideData, driverIds required' });
    return;
  }
  
  logger.info(`[INTERNAL] broadcast-ride-request called for ride ${rideId}`);
  const result = broadcastRideRequest(rideId, rideData, driverIds);
  
  // Return detailed result for debugging
  res.status(200).json({ 
    success: true, // HTTP call succeeded even if no drivers received
    broadcast: result,
  });
}));

app.post('/internal/ride-status-update', authenticateInternal, express.json(), asyncHandler(async (req, res) => {
  const { rideId, status, data } = req.body;
  if (!rideId || !status) {
    res.status(400).json({ success: false, message: 'rideId, status required' });
    return;
  }
  logger.info(`[INTERNAL] ride-status-update called: ride=${rideId}, status=${status}`);
  broadcastRideStatusUpdate(rideId, status, data);
  res.status(200).json({ success: true });
}));

app.post('/internal/driver-assigned', authenticateInternal, express.json(), asyncHandler(async (req, res) => {
  const { rideId, driver } = req.body;
  if (!rideId || !driver) {
    res.status(400).json({ success: false, message: 'rideId, driver required' });
    return;
  }
  logger.info(`[INTERNAL] driver-assigned called: ride=${rideId}, driver=${driver?.id}`);
  broadcastDriverAssigned(rideId, driver);
  res.status(200).json({ success: true });
}));

app.post('/internal/ride-cancelled', authenticateInternal, express.json(), asyncHandler(async (req, res) => {
  const { rideId, cancelledBy, reason } = req.body;
  if (!rideId) {
    res.status(400).json({ success: false, message: 'rideId required' });
    return;
  }
  logger.info(`[INTERNAL] ride-cancelled called: ride=${rideId}, by=${cancelledBy}`);
  broadcastRideCancelled(rideId, cancelledBy, reason);
  res.status(200).json({ success: true });
}));

app.post('/internal/broadcast-ride-chat', authenticateInternal, express.json(), asyncHandler(async (req, res) => {
  const { rideId, message } = req.body;
  if (!rideId || !message || !message.id || !message.senderId || !message.message) {
    res.status(400).json({ success: false, message: 'rideId and message { id, senderId, message, timestamp } required' });
    return;
  }
  broadcastRideChatMessage(rideId, {
    id: message.id,
    senderId: message.senderId,
    message: message.message,
    timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
  });
  res.status(200).json({ success: true });
}));

// ════════════════════════════════════════════════════════════════════════════════
// Internal APIs: In-Memory State Access (Fireball + RAMEN)
//
// These endpoints allow other services (ride-service, pricing-service)
// to query real-time state from memory instead of the database.
//
// Pattern: Service → HTTP → In-Memory Lookup (0.1ms) vs Service → DB Query (20-100ms)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * RAMEN: Find nearby drivers from in-memory H3 geospatial index.
 * Replaces: pricing-service → prisma.driver.findMany({h3Index: {in: cells}})
 * 
 * Speed: 0.01-0.1ms (in-memory) vs 20-100ms (DB query) = 1000x faster
 */
app.get('/internal/nearby-drivers', authenticateInternal, asyncHandler(async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const radius = parseFloat(req.query.radius as string) || 10;
  const vehicleType = req.query.vehicleType as string | undefined;

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ success: false, message: 'lat, lng required' });
    return;
  }

  const drivers = await driverStateStore.findNearbyDrivers(lat, lng, radius, vehicleType);
  
  res.json({
    success: true,
    data: {
      drivers: drivers.map(d => ({
        id: d.id,
        userId: d.userId,
        lat: d.lat,
        lng: d.lng,
        h3Index: d.h3Index,
        distance: d.lat && d.lng ? undefined : null, // Calculated by caller
        vehicleType: d.vehicleType,
        vehicleNumber: d.vehicleNumber,
        vehicleModel: d.vehicleModel,
        rating: d.rating,
        firstName: d.firstName,
        lastName: d.lastName,
        phone: d.phone,
        profileImage: d.profileImage,
      })),
      count: drivers.length,
      source: 'in-memory-ramen',
    },
  });
}));

/**
 * RAMEN: Get driver state from memory.
 * Replaces: prisma.driver.findUnique() for real-time state checks
 */
app.get('/internal/driver-state/:driverId', authenticateInternal, asyncHandler(async (req, res) => {
  const inputId = req.params.driverId;
  const driverId = await driverStateStore.resolveDriverId(inputId);
  
  if (!driverId) {
    res.status(404).json({ success: false, message: 'Driver not found in memory' });
    return;
  }

  const state = await driverStateStore.getDriver(driverId);
  if (!state) {
    res.status(404).json({ success: false, message: 'Driver state not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      id: state.id,
      userId: state.userId,
      isOnline: state.isOnline,
      isActive: state.isActive,
      isVerified: state.isVerified,
      lat: state.lat,
      lng: state.lng,
      h3Index: state.h3Index,
      heading: state.heading,
      speed: state.speed,
      lastActiveAt: state.lastActiveAt,
      connectedTransports: Array.from(state.connectedTransports),
      firstName: state.firstName,
      lastName: state.lastName,
      vehicleNumber: state.vehicleNumber,
      vehicleModel: state.vehicleModel,
      rating: state.rating,
    },
    source: 'in-memory-ramen',
  });
}));

/**
 * RAMEN: Update driver location in memory (no DB write, instant propagation).
 * Replaces: prisma.driver.update() for location updates
 */
app.post('/internal/driver-location', authenticateInternal, asyncHandler(async (req, res) => {
  const { driverId, lat, lng, heading, speed } = req.body;
  if (!driverId || lat === undefined || lng === undefined) {
    res.status(400).json({ success: false, message: 'driverId, lat, lng required' });
    return;
  }

  const result = await driverStateStore.updateLocation(driverId, lat, lng, heading, speed);
  if (!result) {
    // Driver not in memory — register them first
    res.status(404).json({ success: false, message: 'Driver not registered in RAMEN. Call POST /internal/register-driver first.' });
    return;
  }

  // Also update SSE H3 subscriptions if cell changed
  if (result.h3Changed) {
    sseManager.updateDriverH3(driverId, result.newH3);
  }

  // Also publish via MQTT for direct subscribers
  mqttBroker.publishDriverLocation(driverId, lat, lng, result.newH3, heading, speed);

  res.json({ success: true, h3Index: result.newH3, h3Changed: result.h3Changed, source: 'in-memory-ramen' });
}));

/**
 * RAMEN: Register or update driver in memory.
 * Called by driver-service when driver goes online.
 */
app.post('/internal/register-driver', authenticateInternal, asyncHandler(async (req, res) => {
  const { driver } = req.body;
  if (!driver || !driver.id || !driver.userId) {
    res.status(400).json({ success: false, message: 'driver object required' });
    return;
  }

  await driverStateStore.registerDriver(driver);
  res.json({ success: true, message: 'Driver registered in RAMEN' });
}));

/**
 * RAMEN: Set driver online/offline status in memory.
 */
app.post('/internal/driver-status', authenticateInternal, asyncHandler(async (req, res) => {
  const { driverId, isOnline } = req.body;
  if (!driverId || isOnline === undefined) {
    res.status(400).json({ success: false, message: 'driverId, isOnline required' });
    return;
  }

  const result = await driverStateStore.setOnlineStatus(driverId, isOnline);
  res.json({ success: result });
}));

/**
 * Fireball: Get ride state from memory.
 * Replaces: prisma.ride.findUnique() for real-time state checks
 */
app.get('/internal/ride-state/:rideId', authenticateInternal, asyncHandler(async (req, res) => {
  const state = await rideStateStore.getRide(req.params.rideId);
  if (!state) {
    res.status(404).json({ success: false, message: 'Ride not found in memory' });
    return;
  }

  res.json({
    success: true,
    data: rideStateStore.toPublicState(state),
    source: 'in-memory-fireball',
  });
}));

/**
 * Fireball: Create/register ride in memory.
 * Called by ride-service after creating the DB record.
 */
app.post('/internal/register-ride', authenticateInternal, asyncHandler(async (req, res) => {
  const { ride } = req.body;
  if (!ride || !ride.id) {
    res.status(400).json({ success: false, message: 'ride object required' });
    return;
  }

  await rideStateStore.createRide(ride);
  res.json({ success: true, message: 'Ride registered in Fireball' });
}));

/**
 * Fireball: Transition ride status in memory (instant push, async DB write).
 */
app.post('/internal/ride-transition', authenticateInternal, asyncHandler(async (req, res) => {
  const { rideId, newStatus, triggeredBy, additionalData } = req.body;
  if (!rideId || !newStatus) {
    res.status(400).json({ success: false, message: 'rideId, newStatus required' });
    return;
  }

  const state = await rideStateStore.transitionStatus(rideId, newStatus, triggeredBy || 'system', additionalData);
  if (!state) {
    res.status(400).json({ success: false, message: 'Invalid transition or ride not found' });
    return;
  }

  res.json({ success: true, data: rideStateStore.toPublicState(state), source: 'in-memory-fireball' });
}));

/**
 * Fireball: Verify OTP from memory (no DB read).
 */
app.post('/internal/verify-otp', authenticateInternal, asyncHandler(async (req, res) => {
  const { rideId, otp } = req.body;
  if (!rideId || !otp) {
    res.status(400).json({ success: false, message: 'rideId, otp required' });
    return;
  }

  const result = await rideStateStore.verifyOtp(rideId, otp);
  res.json({ success: result.valid, error: result.error });
}));

/**
 * Fireball: Update driver location for an active ride (no DB write).
 */
app.post('/internal/ride-location', authenticateInternal, asyncHandler(async (req, res) => {
  const { rideId, lat, lng, heading, speed } = req.body;
  if (!rideId || lat === undefined || lng === undefined) {
    res.status(400).json({ success: false, message: 'rideId, lat, lng required' });
    return;
  }

  const result = await rideStateStore.updateRideLocation(rideId, lat, lng, heading, speed);
  res.json({ success: result });
}));

/**
 * Fireball: Get pending rides from memory (for driver polling fallback).
 */
app.get('/internal/pending-rides', authenticateInternal, asyncHandler(async (req, res) => {
  const rides = await rideStateStore.getPendingRides();
  res.json({
    success: true,
    data: { rides: rides.map(r => rideStateStore.toPublicState(r)), count: rides.length },
    source: 'in-memory-fireball',
  });
}));

/**
 * Combined metrics for Fireball + RAMEN + EventBus
 */
app.get('/internal/state-metrics', authenticateInternal, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: {
      fireball: await rideStateStore.getMetrics(),
      ramen: await driverStateStore.getMetrics(),
      eventBus: eventBus.getMetrics(),
      sse: sseManager.getStats(),
      mqtt: mqttBroker.getStats(),
    },
  });
}));

app.get('/api/realtime/stats', optionalAuth, asyncHandler(async (req, res) => {
  const stats = await getRealTimeStats();
  res.status(200).json({ success: true, data: stats });
}));

// DEBUG ENDPOINT: Get detailed socket connection state
app.get('/api/realtime/debug/connections', asyncHandler(async (req, res) => {
  const availableDriversRoom = io.sockets.adapter.rooms.get('available-drivers');
  
  // Get all connected drivers with their socket info
  const drivers: Array<{
    driverId: string;
    socketIds: string[];
    inDriverRoom: boolean;
    inAvailableRoom: boolean;
  }> = [];
  
  driverSockets.forEach((sockets, driverId) => {
    const driverRoom = io.sockets.adapter.rooms.get(`driver-${driverId}`);
    drivers.push({
      driverId,
      socketIds: Array.from(sockets),
      inDriverRoom: (driverRoom?.size || 0) > 0,
      inAvailableRoom: Array.from(sockets).some(socketId => 
        availableDriversRoom?.has(socketId) || false
      ),
    });
  });
  
  // Get DB state for comparison
  const dbOnlineDrivers = await prisma.driver.findMany({
    where: { isOnline: true, isActive: true },
    select: { id: true, userId: true, isOnline: true, currentLatitude: true, currentLongitude: true },
  });
  
  const inconsistencies: string[] = [];
  
  // Check for drivers online in DB but not connected
  dbOnlineDrivers.forEach(dbDriver => {
    if (!driverSockets.has(dbDriver.id)) {
      inconsistencies.push(`Driver ${dbDriver.id} is online in DB but NOT connected to Socket.io`);
    }
  });
  
  // Check for drivers connected but not online in DB
  driverSockets.forEach((_, driverId) => {
    const dbDriver = dbOnlineDrivers.find(d => d.id === driverId);
    if (!dbDriver) {
      inconsistencies.push(`Driver ${driverId} is connected to Socket.io but NOT online in DB`);
    }
  });
  
  res.status(200).json({
    success: true,
    data: {
      socketState: {
        totalConnections: io.sockets.sockets.size,
        uniqueDriversConnected: driverSockets.size,
        availableDriversRoomSize: availableDriversRoom?.size || 0,
        connectedDrivers: drivers,
      },
      dbState: {
        onlineDriversInDb: dbOnlineDrivers.length,
        drivers: dbOnlineDrivers,
      },
      inconsistencies,
      timestamp: new Date().toISOString(),
    },
  });
}));

app.get(
  '/api/realtime/location-stats',
  [
    query('lat').isFloat({ min: -90, max: 90 }),
    query('lng').isFloat({ min: -180, max: 180 }),
    query('radius').optional().isFloat({ min: 0.1, max: 50 }),
  ],
  optionalAuth,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const radius = parseFloat(req.query.radius as string) || 5;
    const stats = await getLocationStats(lat, lng, radius);
    res.status(200).json({ success: true, data: stats });
  })
);

app.post(
  '/api/realtime/update-driver-location',
  [
    body('driverId').isString().notEmpty(),
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
    body('heading').optional().isFloat({ min: 0, max: 360 }),
    body('speed').optional().isFloat({ min: 0 }),
  ],
  optionalAuth,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { driverId, lat, lng, heading, speed } = req.body;
    await updateDriverLocation(driverId, lat, lng, heading, speed);
    res.status(200).json({ success: true, message: 'Driver location updated successfully' });
  })
);

app.get('/api/realtime/driver-heatmap', optionalAuth, asyncHandler(async (req, res) => {
  const data = await getDriverHeatmapData();
  res.status(200).json({ success: true, data: data });
}));

app.get('/api/realtime/demand-hotspots', optionalAuth, asyncHandler(async (req, res) => {
  const data = await getDemandHotspots();
  res.status(200).json({ success: true, data: data });
}));

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();

  // ── Initialize In-Memory State Stores (Fireball + RAMEN) ───────────────────
  // Hydrates active rides and drivers from DB into memory.
  // After this, all real-time queries hit memory (0.01ms) instead of DB (20-100ms).
  try {
    await initializeStateSync();
    logger.info('[STARTUP] Fireball + RAMEN state stores initialized');
  } catch (stateError) {
    logger.error('[STARTUP] State sync initialization failed (non-fatal, will use DB fallback)', { error: stateError });
  }

  // ── Start MQTT Broker ──────────────────────────────────────────────────────
  // MQTT runs on separate ports (TCP: 1883, WS: 8883) for driver location streaming.
  // Designed for poor/unstable networks common in Indian tier-2/3 cities.
  try {
    await mqttBroker.start();
    logger.info('[STARTUP] MQTT broker started successfully');
  } catch (mqttError) {
    // MQTT failure is non-fatal - SSE and Socket.io still work
    logger.warn('[STARTUP] MQTT broker failed to start (non-fatal)', { error: mqttError });
  }

  // ── Start HTTP + Socket.io Server ──────────────────────────────────────────
  server.listen(PORT, async () => {
    const rideMetrics = await rideStateStore.getMetrics();
    const driverMetrics = await driverStateStore.getMetrics();
    
    logger.info(`════════════════════════════════════════════════════════════════`);
    logger.info(`  Raahi Realtime Service - Hybrid Transport Architecture`);
    logger.info(`════════════════════════════════════════════════════════════════`);
    logger.info(`  HTTP + SSE : port ${PORT}`);
    logger.info(`  Socket.io  : port ${PORT} (/socket.io)`);
    logger.info(`  MQTT TCP   : port ${process.env.MQTT_TCP_PORT || 1883}`);
    logger.info(`  MQTT WS    : port ${process.env.MQTT_WS_PORT || 8883}`);
    logger.info(`────────────────────────────────────────────────────────────────`);
    logger.info(`  Protocols:`);
    logger.info(`    SSE  → Ride status, driver assignment, notifications`);
    logger.info(`    MQTT → Driver location streaming, poor network support`);
    logger.info(`    WS   → Legacy Socket.io (backward compatibility)`);
    logger.info(`    BIN  → Binary location encoding (gRPC-style)`);
    logger.info(`────────────────────────────────────────────────────────────────`);
    logger.info(`  H3 Integration: All protocols use H3 hexagonal indexing`);
    logger.info(`  Event Bus: ${eventBus.getMetrics().transports.join(', ')}`);
    logger.info(`────────────────────────────────────────────────────────────────`);
    logger.info(`  In-Memory State (Uber-style):`);
    logger.info(`    Fireball → Ride state machine (${rideMetrics.ridesInMemory} rides)`);
    logger.info(`    RAMEN    → Driver state/location (${driverMetrics.totalDrivers} drivers, ${driverMetrics.onlineDrivers} online, redis=${driverMetrics.redisEnabled})`);
    logger.info(`════════════════════════════════════════════════════════════════`);
  });
};

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('[SHUTDOWN] Received SIGTERM, shutting down gracefully...');
  await shutdownStateSync();  // Flush pending DB writes
  sseManager.shutdown();
  await mqttBroker.shutdown();
  server.close(() => {
    logger.info('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  logger.info('[SHUTDOWN] Received SIGINT, shutting down gracefully...');
  await shutdownStateSync();  // Flush pending DB writes
  sseManager.shutdown();
  await mqttBroker.shutdown();
  server.close(() => {
    logger.info('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});

start().catch((err) => {
  logger.error('Failed to start realtime-service', { error: err });
  process.exit(1);
});
