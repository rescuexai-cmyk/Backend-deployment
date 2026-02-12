import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, optionalAuth, errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { prisma } from '@raahi/shared';
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
      select: { id: true, userId: true, isOnline: true, isActive: true, isVerified: true, currentLatitude: true, currentLongitude: true },
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
    logger.info(`[SOCKET] DB State: isOnline=${dbDriver.isOnline}, isActive=${dbDriver.isActive}, isVerified=${dbDriver.isVerified}`);
    logger.info(`[SOCKET] DB Location: (${dbDriver.currentLatitude}, ${dbDriver.currentLongitude})`);
    
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
    
    if (!dbDriver.isActive) {
      logger.error(`[SOCKET] ❌ Driver ${driverId} is NOT ACTIVE - cannot receive rides`);
      socket.emit('registration-error', { 
        message: 'Driver account is not active',
        driverId,
        eventName,
      });
      return null;
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
    
    logger.info(`[SOCKET] ✅ Driver REGISTERED SUCCESSFULLY`);
    logger.info(`[SOCKET]   - Driver ID: ${driverId}`);
    logger.info(`[SOCKET]   - Socket ID: ${socket.id}`);
    logger.info(`[SOCKET]   - In driver-${driverId} room: ${inDriverRoom} (size: ${driverRoom?.size})`);
    logger.info(`[SOCKET]   - In available-drivers room: ${inAvailableRoom} (size: ${availableRoom?.size})`);
    logger.info(`[SOCKET]   - DB isOnline: ${dbDriver.isOnline}`);
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
  
  // Driver location update during ride
  socket.on('location-update', (data: { rideId: string; lat: number; lng: number; heading?: number; speed?: number }) => {
    if (!data.rideId || typeof data.rideId !== 'string') return;
    if (typeof data.lat !== 'number' || typeof data.lng !== 'number') return;
    updateActivity();
    
    io.to(`ride-${data.rideId}`).emit('driver-location', {
      ...data,
      timestamp: new Date().toISOString(),
    });
  });
  
  socket.on('disconnect', (reason) => {
    const driverId = connectedDrivers.get(socket.id);
    if (driverId) {
      connectedDrivers.delete(socket.id);
      
      // Remove from multi-device tracking
      const sockets = driverSockets.get(driverId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          driverSockets.delete(driverId);
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
  res.json({ status: 'OK', service: 'realtime-service', timestamp: new Date().toISOString() });
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
  server.listen(PORT, () => logger.info(`Realtime service (Socket.io + HTTP) running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start realtime-service', { error: err });
  process.exit(1);
});
