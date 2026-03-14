import express, { Response } from 'express';
import { randomUUID } from 'crypto';
import { body, query, validationResult } from 'express-validator';
import { authenticate, AuthRequest } from '@raahi/shared';
import { asyncHandler } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import { canDriverStartRides, DRIVER_NOT_VERIFIED_RIDE_ERROR } from '@raahi/shared';
import * as rideService from '../rideService';
import { broadcastRideChatMessage, broadcastRideChatRead } from '../httpClients';

const router = express.Router();
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:5006';
const REALTIME_SERVICE_URL = process.env.REALTIME_SERVICE_URL || 'http://realtime-service:5007';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';

type RideChatAccess = {
  ride: {
    id: string;
    passengerId: string;
    driverId: string | null;
  };
  driverUserId: string | null;
  isParticipant: boolean;
};

async function getRideChatAccess(rideId: string, userId: string): Promise<RideChatAccess | null> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { id: true, passengerId: true, driverId: true },
  });
  if (!ride) return null;

  let driverUserId: string | null = null;
  if (ride.driverId) {
    const driver = await prisma.driver.findUnique({
      where: { id: ride.driverId },
      select: { userId: true },
    });
    driverUserId = driver?.userId ?? null;
  }

  const isParticipant = userId === ride.passengerId || (driverUserId != null && userId === driverUserId);
  return { ride, driverUserId, isParticipant };
}

async function isRecipientChatOpen(rideId: string, userId: string): Promise<boolean> {
  try {
    const q = new URLSearchParams({ rideId, userId });
    const response = await fetch(`${REALTIME_SERVICE_URL}/internal/chat-presence?${q.toString()}`, {
      method: 'GET',
      headers: { 'x-internal-api-key': INTERNAL_API_KEY },
    });
    if (!response.ok) return false;
    const payload = await response.json() as { success?: boolean; data?: { isChatOpen?: boolean } };
    return payload.success === true && payload.data?.isChatOpen === true;
  } catch {
    return false;
  }
}

async function sendChatPushNotification(params: {
  recipientUserId: string;
  senderRoleLabel: 'Driver' | 'Passenger';
  senderName?: string | null;
  messageText: string;
  rideId: string;
  senderId: string;
  messageId: string;
}): Promise<void> {
  try {
    const senderName = (params.senderName ?? '').trim();
    const senderTitle = senderName.length > 0
      ? `${params.senderRoleLabel} ${senderName}`
      : params.senderRoleLabel;
    await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications/internal/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        userId: params.recipientUserId,
        title: senderTitle,
        body: params.messageText,
        data: {
          type: 'CHAT_MESSAGE',
          messageType: 'RIDE_CHAT',
          rideId: params.rideId,
          senderId: params.senderId,
          messageId: params.messageId,
          senderName,
          senderRole: params.senderRoleLabel.toUpperCase(),
          deepLink: `raahi://ride-chat/${params.rideId}`,
        },
        saveToDb: false,
      }),
    });
  } catch {
    // Non-critical path: never break chat persistence/realtime on push failure.
  }
}

/**
 * @openapi
 * /api/rides:
 *   post:
 *     tags: [Rides]
 *     summary: Create a new ride
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pickupLat, pickupLng, dropLat, dropLng, pickupAddress, dropAddress, paymentMethod]
 *             properties:
 *               pickupLat:
 *                 type: number
 *                 minimum: -90
 *                 maximum: 90
 *               pickupLng:
 *                 type: number
 *                 minimum: -180
 *                 maximum: 180
 *               dropLat:
 *                 type: number
 *               dropLng:
 *                 type: number
 *               pickupAddress:
 *                 type: string
 *               dropAddress:
 *                 type: string
 *               paymentMethod:
 *                 type: string
 *                 enum: [CASH, CARD, UPI, WALLET]
 *               scheduledTime:
 *                 type: string
 *                 format: date-time
 *               vehicleType:
 *                 type: string
 *     responses:
 *       201:
 *         description: Ride created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   $ref: '#/components/schemas/Ride'
 *       400:
 *         description: Validation failed
 */
router.post(
  '/',
  authenticate,
  [
    body('pickupLat').isFloat({ min: -90, max: 90 }),
    body('pickupLng').isFloat({ min: -180, max: 180 }),
    body('dropLat').isFloat({ min: -90, max: 90 }),
    body('dropLng').isFloat({ min: -180, max: 180 }),
    body('pickupAddress').isString().notEmpty(),
    body('dropAddress').isString().notEmpty(),
    body('paymentMethod').isIn(['CASH', 'CARD', 'UPI', 'WALLET']),
    body('scheduledTime').optional().isISO8601(),
    body('vehicleType').optional().isString(),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { pickupLat, pickupLng, dropLat, dropLng, pickupAddress, dropAddress, paymentMethod, scheduledTime, vehicleType } = req.body;
    const ride = await rideService.createRide({
      passengerId: req.user!.id,
      pickupLat,
      pickupLng,
      dropLat,
      dropLng,
      pickupAddress,
      dropAddress,
      paymentMethod,
      scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
      vehicleType,
    });
    res.status(201).json({ success: true, message: 'Ride created successfully', data: ride });
  })
);

/**
 * @openapi
 * /api/rides:
 *   get:
 *     tags: [Rides]
 *     summary: List user's rides
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           maximum: 50
 *     responses:
 *       200:
 *         description: List of rides
 */
router.get(
  '/',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const result = await rideService.getUserRides(req.user!.id, page, limit);
    res.status(200).json({ success: true, data: result });
  })
);

/**
 * @openapi
 * /api/rides/available:
 *   get:
 *     tags: [Rides]
 *     summary: Get available rides for driver
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: lat
 *         required: true
 *         schema:
 *           type: number
 *       - in: query
 *         name: lng
 *         required: true
 *         schema:
 *           type: number
 *       - in: query
 *         name: radius
 *         schema:
 *           type: integer
 *           default: 10
 *     responses:
 *       200:
 *         description: Available rides
 *       403:
 *         description: Driver access required
 */
router.get('/available', authenticate, [
  query('lat').isFloat({ min: -90, max: 90 }),
  query('lng').isFloat({ min: -180, max: 180 }),
  query('radius').optional().isInt({ min: 1, max: 50 }),
], asyncHandler(async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    return;
  }
  const driver = await prisma.driver.findUnique({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(403).json({ success: false, message: 'Driver access required' });
    return;
  }
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const radius = parseInt(req.query.radius as string) || 10;
  const rides = await rideService.getAvailableRidesForDriver(lat, lng, radius, driver.id);
  res.status(200).json({ success: true, data: { rides, total: rides.length } });
}));

/**
 * @openapi
 * /api/rides/share/{token}:
 *   get:
 *     tags: [Rides]
 *     summary: Get ride by share token (public)
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Ride details
 *       404:
 *         description: Share link invalid or expired
 */
router.get('/share/:token', asyncHandler(async (req: AuthRequest, res: Response) => {
  const record = await prisma.rideShareToken.findUnique({
    where: { token: req.params.token },
    include: {
      ride: {
        select: {
          id: true,
          status: true,
          pickupAddress: true,
          dropAddress: true,
          pickupLatitude: true,
          pickupLongitude: true,
          dropLatitude: true,
          dropLongitude: true,
          createdAt: true,
          driverId: true,
        },
        include: {
          driver: {
            select: {
              user: { select: { firstName: true, lastName: true } },
              vehicleNumber: true,
              vehicleModel: true,
            },
          },
        },
      },
    },
  });
  if (!record || record.expiresAt < new Date()) {
    res.status(404).json({ success: false, message: 'Share link invalid or expired' });
    return;
  }
  const ride = record.ride;
  res.status(200).json({
    success: true,
    data: {
      rideId: ride.id,
      status: ride.status,
      pickupAddress: ride.pickupAddress,
      dropAddress: ride.dropAddress,
      pickup: { lat: ride.pickupLatitude, lng: ride.pickupLongitude },
      drop: { lat: ride.dropLatitude, lng: ride.dropLongitude },
      createdAt: ride.createdAt,
      driver: ride.driver
        ? {
            name: `${ride.driver.user?.firstName || ''} ${ride.driver.user?.lastName || ''}`.trim() || 'Driver',
            vehicleNumber: ride.driver.vehicleNumber,
            vehicleModel: ride.driver.vehicleModel,
          }
        : null,
    },
  });
}));

/**
 * @openapi
 * /api/rides/{id}:
 *   get:
 *     tags: [Rides]
 *     summary: Get ride by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Ride details
 *       403:
 *         description: Access denied
 *       404:
 *         description: Ride not found
 */
router.get('/:id', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  // Pass requester ID so we can determine if they should see the OTP
  const ride = await rideService.getRideById(req.params.id, req.user!.id);
  if (!ride) {
    res.status(404).json({ success: false, message: 'Ride not found' });
    return;
  }
  
  // Check if user is passenger or driver (need to look up driver by userId)
  let isDriver = false;
  if (ride.driverId) {
    const driver = await prisma.driver.findUnique({
      where: { userId: req.user!.id },
      select: { id: true }
    });
    isDriver = driver?.id === ride.driverId;
  }
  
  if (ride.passengerId !== req.user!.id && !isDriver) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }
  res.status(200).json({ success: true, data: ride });
}));

/**
 * @openapi
 * /api/rides/{id}/assign-driver:
 *   post:
 *     tags: [Rides]
 *     summary: Assign driver to ride (admin)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [driverId]
 *             properties:
 *               driverId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Driver assigned
 */
router.post('/:id/assign-driver', authenticate, [body('driverId').isString().notEmpty()], asyncHandler(async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    return;
  }
  const ride = await rideService.assignDriver(req.params.id, req.body.driverId);
  res.status(200).json({ success: true, message: 'Driver assigned successfully', data: ride });
}));

/**
 * @openapi
 * /api/rides/{id}/accept:
 *   post:
 *     tags: [Rides]
 *     summary: Driver accepts a ride
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Ride accepted
 *       403:
 *         description: Driver not verified
 *       404:
 *         description: Ride not found
 *       409:
 *         description: Ride already taken
 */
router.post('/:id/accept', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const rideId = req.params.id;
  const userId = req.user!.id;
  const acceptTimestamp = new Date().toISOString();
  
  // CRITICAL: Log every accept attempt
  console.log(`[RIDE_ACCEPT] ========== ACCEPT ATTEMPT ==========`);
  console.log(`[RIDE_ACCEPT] Ride ID: ${rideId}`);
  console.log(`[RIDE_ACCEPT] User ID: ${userId}`);
  console.log(`[RIDE_ACCEPT] Timestamp: ${acceptTimestamp}`);
  
  // Get driver profile for the authenticated user
  const driver = await prisma.driver.findUnique({ 
    where: { userId },
    select: { id: true, isVerified: true, isOnline: true, isActive: true, onboardingStatus: true }
  });
  
  if (!driver) {
    console.log(`[RIDE_ACCEPT] ❌ REJECTED: No driver profile for user ${userId}`);
    res.status(403).json({ success: false, message: 'Driver access required', code: 'FORBIDDEN' });
    return;
  }
  
  console.log(`[RIDE_ACCEPT] Driver ID: ${driver.id}`);
  console.log(`[RIDE_ACCEPT] Driver state: isVerified=${driver.isVerified}, isOnline=${driver.isOnline}, isActive=${driver.isActive}, onboardingStatus=${driver.onboardingStatus}`);
  
  // CRITICAL: Check if driver can start rides using unified verification check
  if (!canDriverStartRides(driver)) {
    console.log(`[RIDE_ACCEPT] ❌ REJECTED: Driver ${driver.id} not verified (isActive=${driver.isActive}, isVerified=${driver.isVerified}, onboardingStatus=${driver.onboardingStatus})`);
    res.status(403).json({ 
      success: false, 
      ...DRIVER_NOT_VERIFIED_RIDE_ERROR,
      verificationState: {
        isActive: driver.isActive,
        isVerified: driver.isVerified,
        onboardingStatus: driver.onboardingStatus,
      },
    });
    return;
  }
  
  if (!driver.isOnline) {
    console.log(`[RIDE_ACCEPT] ⚠️ WARNING: Driver ${driver.id} is OFFLINE in DB but trying to accept`);
    // Still allow - they might have just gone online
  }
  
  // Check ride exists and is still available
  const existingRide = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { id: true, status: true, driverId: true }
  });
  
  if (!existingRide) {
    console.log(`[RIDE_ACCEPT] ❌ REJECTED: Ride ${rideId} not found`);
    res.status(404).json({ success: false, message: 'Ride not found', code: 'RIDE_NOT_FOUND' });
    return;
  }
  
  console.log(`[RIDE_ACCEPT] Ride state: status=${existingRide.status}, driverId=${existingRide.driverId}`);
  
  if (existingRide.driverId) {
    console.log(`[RIDE_ACCEPT] ❌ REJECTED: Ride ${rideId} already assigned to driver ${existingRide.driverId}`);
    res.status(409).json({ 
      success: false, 
      message: 'This ride has already been accepted by another driver',
      code: 'RIDE_ALREADY_TAKEN',
      assignedTo: existingRide.driverId,
    });
    return;
  }
  
  if (existingRide.status !== 'PENDING') {
    console.log(`[RIDE_ACCEPT] ❌ REJECTED: Ride ${rideId} status is ${existingRide.status}, not PENDING`);
    res.status(409).json({ 
      success: false, 
      message: `Cannot accept ride with status: ${existingRide.status}`,
      code: 'INVALID_RIDE_STATUS',
      currentStatus: existingRide.status,
    });
    return;
  }
  
  try {
    console.log(`[RIDE_ACCEPT] Attempting to assign driver ${driver.id} to ride ${rideId}...`);
    const ride = await rideService.assignDriver(rideId, driver.id);
    console.log(`[RIDE_ACCEPT] ✅ SUCCESS: Driver ${driver.id} assigned to ride ${rideId}`);
    console.log(`[RIDE_ACCEPT] ========== ACCEPT COMPLETE ==========`);
    res.status(200).json({ success: true, message: 'Ride accepted successfully', data: ride });
  } catch (error: any) {
    console.log(`[RIDE_ACCEPT] ❌ FAILED: ${error.message}`);
    console.log(`[RIDE_ACCEPT] Error details:`, error);
    
    // Handle race condition - ride already taken
    if (error.message?.includes('already assigned') || error.message?.includes('already taken')) {
      console.log(`[RIDE_ACCEPT] Race condition detected - ride was taken by another driver`);
      res.status(409).json({ 
        success: false, 
        message: 'This ride has already been accepted by another driver',
        code: 'RIDE_ALREADY_TAKEN'
      });
      return;
    }
    
    // Handle other known errors
    if (error.message?.includes('not found')) {
      res.status(404).json({ success: false, message: error.message, code: 'NOT_FOUND' });
      return;
    }
    
    if (error.message?.includes('not online') || error.message?.includes('not active')) {
      res.status(403).json({ success: false, message: error.message, code: 'DRIVER_UNAVAILABLE' });
      return;
    }
    
    if (error.message?.includes('Vehicle type mismatch')) {
      console.log(`[RIDE_ACCEPT] ❌ REJECTED: ${error.message}`);
      res.status(403).json({ success: false, message: error.message, code: 'VEHICLE_TYPE_MISMATCH' });
      return;
    }
    
    console.log(`[RIDE_ACCEPT] ========== ACCEPT FAILED ==========`);
    throw error;
  }
}));

// Driver starts ride with OTP verification
router.post(
  '/:id/start',
  authenticate,
  [body('otp').isString().isLength({ min: 4, max: 4 })],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed - OTP must be 4 digits', errors: errors.array() });
      return;
    }
    
    const rideId = req.params.id;
    const providedOtp = req.body.otp;
    
    console.log(`[RIDE_START] ========== START RIDE ATTEMPT ==========`);
    console.log(`[RIDE_START] Ride ID: ${rideId}`);
    // SECURITY FIX: Do NOT log the OTP values
    console.log(`[RIDE_START] OTP provided: [REDACTED]`);
    
    // Get driver profile
    const driver = await prisma.driver.findUnique({ 
      where: { userId: req.user!.id },
      select: { id: true }
    });
    
    if (!driver) {
      console.log(`[RIDE_START] ❌ REJECTED: No driver profile for user ${req.user!.id}`);
      res.status(403).json({ success: false, message: 'Driver access required', code: 'FORBIDDEN' });
      return;
    }
    
    // Get ride with OTP
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: { id: true, status: true, driverId: true, rideOtp: true }
    });
    
    if (!ride) {
      console.log(`[RIDE_START] ❌ REJECTED: Ride ${rideId} not found`);
      res.status(404).json({ success: false, message: 'Ride not found', code: 'NOT_FOUND' });
      return;
    }
    
    // Verify driver is assigned to this ride
    if (ride.driverId !== driver.id) {
      console.log(`[RIDE_START] ❌ REJECTED: Driver ${driver.id} is not assigned to ride ${rideId}`);
      res.status(403).json({ success: false, message: 'You are not assigned to this ride', code: 'FORBIDDEN' });
      return;
    }
    
    // Verify ride is in correct status (DRIVER_ARRIVED)
    if (ride.status !== 'DRIVER_ARRIVED') {
      console.log(`[RIDE_START] ❌ REJECTED: Ride status is ${ride.status}, expected DRIVER_ARRIVED`);
      res.status(400).json({ 
        success: false, 
        message: `Cannot start ride with status: ${ride.status}. Driver must arrive first.`,
        code: 'INVALID_STATUS',
        currentStatus: ride.status
      });
      return;
    }
    
    // Verify OTP (SECURITY: compare but don't log values)
    if (ride.rideOtp !== providedOtp) {
      console.log(`[RIDE_START] ❌ REJECTED: Invalid OTP provided`);
      res.status(400).json({ 
        success: false, 
        message: 'Invalid OTP. Please ask the passenger for the correct code.',
        code: 'INVALID_OTP'
      });
      return;
    }
    
    console.log(`[RIDE_START] ✅ OTP verified successfully`);
    
    // Start the ride
    const updatedRide = await rideService.updateRideStatus(rideId, 'RIDE_STARTED', req.user!.id);
    
    console.log(`[RIDE_START] ✅ Ride ${rideId} started successfully`);
    console.log(`[RIDE_START] ========== START RIDE COMPLETE ==========`);
    
    res.status(200).json({ success: true, message: 'Ride started successfully', data: updatedRide });
  })
);

router.put(
  '/:id/status',
  authenticate,
  [
    body('status').isIn(['CONFIRMED', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_COMPLETED', 'CANCELLED']),
    body('cancellationReason').optional().isString(),
    body('otp').optional().isString().isLength({ min: 4, max: 4 }), // OTP required for RIDE_STARTED
    // Fare adjustments (driver input when completing ride)
    body('tolls').optional().isFloat({ min: 0 }),
    body('waitingMinutes').optional().isInt({ min: 0 }),
    body('parkingFees').optional().isFloat({ min: 0 }),
    body('extraStopsCount').optional().isInt({ min: 0 }),
    body('discountPercent').optional().isFloat({ min: 0, max: 100 }),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { status, cancellationReason, otp, tolls, waitingMinutes, parkingFees, extraStopsCount, discountPercent } = req.body;
    const rideId = req.params.id;
    
    // Get ride details
    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      select: { id: true, status: true, driverId: true, passengerId: true, rideOtp: true }
    });
    
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    
    // AUTHORIZATION FIX: Driver-specific statuses can only be set by the assigned driver
    const driverOnlyStatuses = ['CONFIRMED', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_COMPLETED'];
    if (driverOnlyStatuses.includes(status)) {
      // Check if user is the assigned driver
      const driver = await prisma.driver.findUnique({
        where: { userId: req.user!.id },
        select: { id: true }
      });
      
      if (!driver) {
        res.status(403).json({ 
          success: false, 
          message: 'Only drivers can update ride to this status',
          code: 'DRIVER_REQUIRED'
        });
        return;
      }
      
      if (ride.driverId !== driver.id) {
        res.status(403).json({ 
          success: false, 
          message: 'Only the assigned driver can update this ride status',
          code: 'NOT_ASSIGNED_DRIVER'
        });
        return;
      }
    }
    
    // If trying to start ride, require OTP verification
    if (status === 'RIDE_STARTED') {
      if (!otp) {
        res.status(400).json({ 
          success: false, 
          message: 'OTP is required to start the ride. Use POST /:id/start endpoint or provide otp in body.',
          code: 'OTP_REQUIRED'
        });
        return;
      }
      
      // Verify OTP (SECURITY: compare but don't log values)
      if (ride.rideOtp !== otp) {
        res.status(400).json({ 
          success: false, 
          message: 'Invalid OTP. Please ask the passenger for the correct code.',
          code: 'INVALID_OTP'
        });
        return;
      }
    }
    
    const fareAdjustments =
      status === 'RIDE_COMPLETED' &&
      (tolls != null || waitingMinutes != null || parkingFees != null || extraStopsCount != null || discountPercent != null)
        ? { tolls, waitingMinutes, parkingFees, extraStopsCount, discountPercent }
        : undefined;

    const updatedRide = await rideService.updateRideStatus(
      rideId,
      status,
      req.user!.id,
      cancellationReason,
      fareAdjustments
    );
    res.status(200).json({ success: true, message: 'Ride status updated successfully', data: updatedRide });
  })
);

// Cancel ride - determines caller role automatically
router.post(
  '/:id/cancel',
  authenticate,
  [body('reason').optional().isString()],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const rideId = req.params.id;
    
    // Get ride details to determine access
    const existingRide = await prisma.ride.findUnique({
      where: { id: rideId },
      select: { id: true, passengerId: true, driverId: true, status: true }
    });
    
    if (!existingRide) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    
    // Check if ride can be cancelled
    const nonCancellableStatuses = ['RIDE_COMPLETED', 'CANCELLED'];
    if (nonCancellableStatuses.includes(existingRide.status)) {
      res.status(400).json({ 
        success: false, 
        message: `Cannot cancel ride with status: ${existingRide.status}`,
        code: 'INVALID_STATUS'
      });
      return;
    }
    
    // Passenger cannot cancel once ride has started (driver entered OTP)
    const isPassenger = existingRide.passengerId === req.user!.id;
    if (isPassenger && existingRide.status === 'RIDE_STARTED') {
      res.status(400).json({ 
        success: false, 
        message: 'Cannot cancel ride after it has started. Please contact the driver if needed.',
        code: 'RIDE_ALREADY_STARTED'
      });
      return;
    }
    
    // Determine who is cancelling
    let cancelledBy: 'passenger' | 'driver';
    
    if (existingRide.passengerId === req.user!.id) {
      cancelledBy = 'passenger';
    } else {
      // Check if user is the assigned driver
      const driver = await prisma.driver.findUnique({
        where: { userId: req.user!.id },
        select: { id: true }
      });
      
      if (driver && existingRide.driverId === driver.id) {
        cancelledBy = 'driver';
      } else {
        res.status(403).json({ 
          success: false, 
          message: 'Only the passenger or assigned driver can cancel this ride',
          code: 'FORBIDDEN'
        });
        return;
      }
    }
    
    console.log(`[RIDE_CANCEL] Ride ${rideId} being cancelled by ${cancelledBy} (user: ${req.user!.id})`);
    
    const ride = await rideService.cancelRide(rideId, cancelledBy, req.body.reason);
    res.status(200).json({ success: true, message: 'Ride cancelled successfully', data: ride });
  })
);

// Driver-specific cancel endpoint (convenience endpoint)
router.post(
  '/:id/driver-cancel',
  authenticate,
  [body('reason').optional().isString()],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const rideId = req.params.id;
    
    // Verify caller is a driver
    const driver = await prisma.driver.findUnique({
      where: { userId: req.user!.id },
      select: { id: true }
    });
    
    if (!driver) {
      res.status(403).json({ success: false, message: 'Driver access required', code: 'DRIVER_REQUIRED' });
      return;
    }
    
    // Get ride and verify driver is assigned
    const existingRide = await prisma.ride.findUnique({
      where: { id: rideId },
      select: { id: true, driverId: true, status: true }
    });
    
    if (!existingRide) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    
    if (existingRide.driverId !== driver.id) {
      res.status(403).json({ 
        success: false, 
        message: 'You are not assigned to this ride',
        code: 'NOT_ASSIGNED_DRIVER'
      });
      return;
    }
    
    // Check if ride can be cancelled
    const nonCancellableStatuses = ['RIDE_COMPLETED', 'CANCELLED'];
    if (nonCancellableStatuses.includes(existingRide.status)) {
      res.status(400).json({ 
        success: false, 
        message: `Cannot cancel ride with status: ${existingRide.status}`,
        code: 'INVALID_STATUS'
      });
      return;
    }
    
    console.log(`[RIDE_CANCEL] Ride ${rideId} being cancelled by driver ${driver.id}`);
    
    const ride = await rideService.cancelRide(rideId, 'driver', req.body.reason);
    res.status(200).json({ success: true, message: 'Ride cancelled successfully', data: ride });
  })
);

router.post(
  '/:id/rating',
  authenticate,
  [
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be an integer between 1 and 5'),
    body('feedback').optional().isString().isLength({ max: 500 }),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const rideId = req.params.id;
    const ride = await rideService.getRideById(rideId);
    
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    
    // Determine rater role
    let raterRole: 'passenger' | 'driver';
    
    if (ride.passengerId === req.user!.id) {
      raterRole = 'passenger';
    } else {
      // Check if user is the assigned driver
      const driver = await prisma.driver.findUnique({
        where: { userId: req.user!.id },
        select: { id: true }
      });
      
      if (driver && ride.driverId === driver.id) {
        raterRole = 'driver';
      } else {
        res.status(403).json({ success: false, message: 'Access denied - you are not part of this ride' });
        return;
      }
    }
    
    try {
      const updated = await rideService.submitRideRating(
        rideId,
        req.body.rating,
        req.body.feedback,
        req.user!.id,
        raterRole
      );
      res.status(200).json({ success: true, message: 'Rating submitted successfully', data: updated });
    } catch (error: any) {
      if (error.message?.includes('already rated')) {
        res.status(409).json({ 
          success: false, 
          message: error.message,
          code: 'ALREADY_RATED'
        });
        return;
      }
      if (error.message?.includes('completed rides')) {
        res.status(400).json({ success: false, message: error.message, code: 'INVALID_STATUS' });
        return;
      }
      throw error;
    }
  })
);

router.get('/:id/receipt', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const ride = await rideService.getRideById(req.params.id);
  if (!ride) {
    res.status(404).json({ success: false, message: 'Ride not found' });
    return;
  }
  if (ride.passengerId !== req.user!.id && ride.driverId !== req.user!.id) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }
  const receipt = {
    rideId: ride.id,
    receiptNumber: `RCP-${ride.id.substring(0, 8).toUpperCase()}`,
    passenger: { id: ride.passengerId, name: (ride as any).passenger ? `${(ride as any).passenger.firstName} ${(ride as any).passenger.lastName || ''}`.trim() : 'Passenger' },
    driver: ride.driver ? { id: ride.driverId, name: `${ride.driver.firstName} ${ride.driver.lastName || ''}`.trim(), vehicleNumber: ride.driver.vehicleNumber, vehicleModel: ride.driver.vehicleModel } : null,
    pickup: { address: ride.pickupAddress, latitude: (ride as any).pickupLatitude, longitude: (ride as any).pickupLongitude },
    drop: { address: ride.dropAddress, latitude: (ride as any).dropLatitude, longitude: (ride as any).dropLongitude },
    distance: ride.distance,
    duration: ride.duration,
    fare: { baseFare: ride.baseFare, distanceFare: ride.distanceFare, timeFare: ride.timeFare, surgeMultiplier: ride.surgeMultiplier, totalFare: ride.totalFare },
    paymentMethod: ride.paymentMethod,
    paymentStatus: ride.paymentStatus,
    status: ride.status,
    timestamps: { created: ride.createdAt, started: ride.startedAt, completed: ride.completedAt },
  };
  res.status(200).json({ success: true, data: receipt });
}));

// Chat messages
router.get('/:id/messages', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const access = await getRideChatAccess(req.params.id, req.user!.id);
  if (!access) {
    res.status(404).json({ success: false, message: 'Ride not found' });
    return;
  }

  if (!access.isParticipant) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const requesterUserId = req.user!.id;
  const counterpartUserId = requesterUserId === access.ride.passengerId
    ? access.driverUserId
    : access.ride.passengerId;

  const messages = await prisma.rideMessage.findMany({
    where: { rideId: req.params.id },
    orderBy: { timestamp: 'asc' },
  });
  const participant = await prisma.rideChatParticipant.findUnique({
    where: { rideId_userId: { rideId: req.params.id, userId: req.user!.id } },
    select: { lastReadAt: true, unreadCount: true },
  });
  const counterpartParticipant = counterpartUserId
    ? await prisma.rideChatParticipant.findUnique({
        where: { rideId_userId: { rideId: req.params.id, userId: counterpartUserId } },
        select: { lastReadAt: true },
      })
    : null;

  const counterpartLastReadAt = counterpartParticipant?.lastReadAt ?? null;
  const enrichedMessages = messages.map((msg) => {
    const isOutgoingForRequester = msg.senderId === requesterUserId;
    const isReadByCounterpart =
      isOutgoingForRequester &&
      counterpartLastReadAt != null &&
      msg.timestamp <= counterpartLastReadAt;

    return {
      ...msg,
      isRead: isReadByCounterpart,
      readAt: isReadByCounterpart ? counterpartLastReadAt : null,
    };
  });
  res.status(200).json({
    success: true,
    data: {
      messages: enrichedMessages,
      unreadCount: participant?.unreadCount ?? 0,
      lastReadAt: participant?.lastReadAt ?? null,
    },
  });
}));

router.post(
  '/:id/messages',
  authenticate,
  [
    body('message').isString().notEmpty(),
    body('clientMessageId').optional().isString().isLength({ min: 8, max: 120 }),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const access = await getRideChatAccess(req.params.id, req.user!.id);
    if (!access) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }

    if (!access.isParticipant) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    const messageText = (req.body.message as string).trim();
    const clientMessageId = (req.body.clientMessageId as string | undefined)?.trim() || null;
    const senderId = req.user!.id;
    const isSenderPassenger = senderId === access.ride.passengerId;
    const receiverUserId = isSenderPassenger ? access.driverUserId : access.ride.passengerId;
    const senderProfile = await prisma.user.findUnique({
      where: { id: senderId },
      select: { firstName: true, lastName: true },
    });
    const senderName = [
      senderProfile?.firstName ?? '',
      senderProfile?.lastName ?? '',
    ].join(' ').trim();

    if (!receiverUserId) {
      res.status(400).json({ success: false, message: 'Receiver not available for this ride' });
      return;
    }

    // Idempotency guard: retries must not duplicate message, unread, or push.
    if (clientMessageId) {
      const existing = await prisma.rideMessage.findFirst({
        where: {
          rideId: req.params.id,
          senderId,
          clientMessageId,
        },
      });
      if (existing) {
        res.status(200).json({
          success: true,
          data: { message: existing, idempotent: true },
        });
        return;
      }
    }

    const now = new Date();
    const { chatMessage, unreadCountForReceiver } = await prisma.$transaction(async (tx) => {
      const chatMessage = await tx.rideMessage.create({
        data: {
          rideId: req.params.id,
          senderId,
          clientMessageId,
          message: messageText,
        },
      });

      // Ensure participant rows exist for both sides.
      await tx.rideChatParticipant.upsert({
        where: { rideId_userId: { rideId: req.params.id, userId: senderId } },
        update: {},
        create: {
          rideId: req.params.id,
          userId: senderId,
          lastReadAt: now,
          unreadCount: 0,
        },
      });
      await tx.rideChatParticipant.upsert({
        where: { rideId_userId: { rideId: req.params.id, userId: receiverUserId } },
        update: {
          unreadCount: { increment: 1 },
        },
        create: {
          rideId: req.params.id,
          userId: receiverUserId,
          lastReadAt: null,
          unreadCount: 1,
        },
      });

      // Keep unreadCount aligned with lastReadAt semantics.
      const receiverParticipant = await tx.rideChatParticipant.findUnique({
        where: { rideId_userId: { rideId: req.params.id, userId: receiverUserId } },
        select: { lastReadAt: true },
      });
      const unreadCountForReceiver = await tx.rideMessage.count({
        where: {
          rideId: req.params.id,
          senderId: { not: receiverUserId },
          timestamp: receiverParticipant?.lastReadAt
              ? { gt: receiverParticipant.lastReadAt }
              : undefined,
        },
      });
      await tx.rideChatParticipant.update({
        where: { rideId_userId: { rideId: req.params.id, userId: receiverUserId } },
        data: { unreadCount: unreadCountForReceiver },
      });

      return { chatMessage, unreadCountForReceiver };
    });

    // Broadcast to ride room so driver/passenger get message in real time.
    await broadcastRideChatMessage(req.params.id, {
      id: chatMessage.id,
      senderId: chatMessage.senderId,
      message: chatMessage.message,
      timestamp: chatMessage.timestamp,
    });

    // Push only when recipient is NOT actively viewing this ride chat.
    const chatOpen = await isRecipientChatOpen(req.params.id, receiverUserId);
    if (!chatOpen) {
      await sendChatPushNotification({
        recipientUserId: receiverUserId,
        senderRoleLabel: isSenderPassenger ? 'Passenger' : 'Driver',
        senderName,
        messageText,
        rideId: req.params.id,
        senderId,
        messageId: chatMessage.id,
      });
    }

    res.status(201).json({
      success: true,
      data: {
        message: chatMessage,
        unreadCount: unreadCountForReceiver,
      },
    });
  })
);

router.post(
  '/:id/messages/read',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const access = await getRideChatAccess(req.params.id, req.user!.id);
    if (!access) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (!access.isParticipant) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    const now = new Date();
    await prisma.rideChatParticipant.upsert({
      where: { rideId_userId: { rideId: req.params.id, userId: req.user!.id } },
      update: {
        lastReadAt: now,
        unreadCount: 0,
      },
      create: {
        rideId: req.params.id,
        userId: req.user!.id,
        lastReadAt: now,
        unreadCount: 0,
      },
    });

    await broadcastRideChatRead(req.params.id, req.user!.id, now);

    res.status(200).json({
      success: true,
      data: { rideId: req.params.id, lastReadAt: now.toISOString(), unreadCount: 0 },
    });
  })
);

router.get(
  '/:id/messages/unread-count',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const access = await getRideChatAccess(req.params.id, req.user!.id);
    if (!access) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (!access.isParticipant) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }

    const participant = await prisma.rideChatParticipant.findUnique({
      where: { rideId_userId: { rideId: req.params.id, userId: req.user!.id } },
      select: { lastReadAt: true, unreadCount: true },
    });

    const unreadCount = await prisma.rideMessage.count({
      where: {
        rideId: req.params.id,
        senderId: { not: req.user!.id },
        timestamp: participant?.lastReadAt ? { gt: participant.lastReadAt } : undefined,
      },
    });

    if ((participant?.unreadCount ?? 0) != unreadCount) {
      await prisma.rideChatParticipant.upsert({
        where: { rideId_userId: { rideId: req.params.id, userId: req.user!.id } },
        update: { unreadCount },
        create: {
          rideId: req.params.id,
          userId: req.user!.id,
          lastReadAt: participant?.lastReadAt ?? null,
          unreadCount,
        },
      });
    }

    res.status(200).json({
      success: true,
      data: {
        rideId: req.params.id,
        unreadCount,
        lastReadAt: participant?.lastReadAt ?? null,
      },
    });
  })
);

// Safety: report emergency during ride (notifies other party + logs)
router.post(
  '/:id/emergency',
  authenticate,
  [body('reason').optional().isString()],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const ride = await prisma.ride.findUnique({
      where: { id: req.params.id },
      select: { id: true, passengerId: true, driverId: true, status: true },
    });
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (ride.passengerId !== req.user!.id && ride.driverId !== req.user!.id) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }
    const reason = req.body.reason || 'Safety alert triggered';
    // Notify the other party (driver gets passenger's alert, passenger gets driver's alert)
    let targetUserId: string | null = null;
    if (ride.passengerId === req.user!.id && ride.driverId) {
      const driver = await prisma.driver.findUnique({ where: { id: ride.driverId }, select: { userId: true } });
      targetUserId = driver?.userId ?? null;
    } else if (ride.driverId && req.user!.id !== ride.passengerId) {
      targetUserId = ride.passengerId;
    }
    if (targetUserId) {
      await prisma.notification.create({
        data: {
          userId: targetUserId,
          title: 'Safety alert',
          message: `Emergency reported for ride: ${reason}`,
          type: 'SYSTEM',
          data: { type: 'emergency', rideId: ride.id, triggeredBy: req.user!.id, reason },
        },
      });
    }
    console.log(`[SAFETY] Emergency reported for ride ${ride.id} by user ${req.user!.id}: ${reason}`);
    res.status(200).json({ success: true, message: 'Safety alert sent', data: { rideId: ride.id } });
  })
);

// Share ride: create a share link (token) so someone can view ride status without logging in
router.post(
  '/:id/share',
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const ride = await prisma.ride.findUnique({
      where: { id: req.params.id },
      select: { id: true, passengerId: true, driverId: true },
    });
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (ride.passengerId !== req.user!.id && ride.driverId !== req.user!.id) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    const token = randomUUID();
    await prisma.rideShareToken.create({
      data: { rideId: ride.id, token, expiresAt },
    });
    const baseUrl = process.env.GATEWAY_URL || process.env.FRONTEND_URL || 'https://app.raahi.com';
    const shareUrl = `${baseUrl}/ride/share/${token}`;
    res.status(201).json({
      success: true,
      message: 'Share link created',
      data: { shareToken: token, shareUrl, expiresAt },
    });
  })
);

router.post(
  '/:id/track',
  authenticate,
  [
    body('lat').isFloat({ min: -90, max: 90 }),
    body('lng').isFloat({ min: -180, max: 180 }),
    body('heading').optional().isFloat({ min: 0, max: 360 }),
    body('speed').optional().isFloat({ min: 0 }),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const driver = await prisma.driver.findUnique({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(403).json({ success: false, message: 'Driver access required' });
      return;
    }
    await rideService.updateDriverLocation(driver.id, req.body.lat, req.body.lng, req.body.heading, req.body.speed);
    res.status(200).json({ success: true, message: 'Location updated successfully' });
  })
);

export default router;
