import express, { Response } from 'express';
import { randomUUID } from 'crypto';
import { body, query, validationResult } from 'express-validator';
import { authenticate, AuthRequest } from '@raahi/shared';
import { asyncHandler } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import * as rideService from '../rideService';
import { broadcastRideChatMessage } from '../httpClients';

const router = express.Router();

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

// Share ride: public endpoint (no auth) - get minimal ride info by share token
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

router.post('/:id/assign-driver', authenticate, [body('driverId').isString().notEmpty()], asyncHandler(async (req: AuthRequest, res: Response) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    return;
  }
  const ride = await rideService.assignDriver(req.params.id, req.body.driverId);
  res.status(200).json({ success: true, message: 'Driver assigned successfully', data: ride });
}));

// Driver self-accept endpoint - driver accepts a ride for themselves
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
    select: { id: true, isVerified: true, isOnline: true, isActive: true }
  });
  
  if (!driver) {
    console.log(`[RIDE_ACCEPT] ❌ REJECTED: No driver profile for user ${userId}`);
    res.status(403).json({ success: false, message: 'Driver access required', code: 'FORBIDDEN' });
    return;
  }
  
  console.log(`[RIDE_ACCEPT] Driver ID: ${driver.id}`);
  console.log(`[RIDE_ACCEPT] Driver state: isVerified=${driver.isVerified}, isOnline=${driver.isOnline}, isActive=${driver.isActive}`);
  
  // Check if driver is verified and can accept rides
  if (!driver.isVerified) {
    console.log(`[RIDE_ACCEPT] ❌ REJECTED: Driver ${driver.id} not verified`);
    res.status(403).json({ success: false, message: 'Driver not verified', code: 'DRIVER_NOT_VERIFIED' });
    return;
  }
  
  if (!driver.isActive) {
    console.log(`[RIDE_ACCEPT] ❌ REJECTED: Driver ${driver.id} not active`);
    res.status(403).json({ success: false, message: 'Driver account not active', code: 'DRIVER_NOT_ACTIVE' });
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
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { status, cancellationReason, otp } = req.body;
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
    
    const updatedRide = await rideService.updateRideStatus(
      rideId,
      status,
      req.user!.id,
      cancellationReason
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
  const ride = await prisma.ride.findUnique({ where: { id: req.params.id } });
  if (!ride) {
    res.status(404).json({ success: false, message: 'Ride not found' });
    return;
  }
  if (ride.passengerId !== req.user!.id && ride.driverId !== req.user!.id) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }
  const messages = await prisma.rideMessage.findMany({
    where: { rideId: req.params.id },
    orderBy: { timestamp: 'asc' },
  });
  res.status(200).json({ success: true, data: { messages } });
}));

router.post(
  '/:id/messages',
  authenticate,
  [body('message').isString().notEmpty()],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const ride = await prisma.ride.findUnique({ where: { id: req.params.id } });
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (ride.passengerId !== req.user!.id && ride.driverId !== req.user!.id) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }
    const chatMessage = await prisma.rideMessage.create({
      data: {
        rideId: req.params.id,
        senderId: req.user!.id,
        message: req.body.message,
      },
    });
    // Broadcast to ride room so driver/passenger get message in real time
    await broadcastRideChatMessage(req.params.id, {
      id: chatMessage.id,
      senderId: chatMessage.senderId,
      message: chatMessage.message,
      timestamp: chatMessage.timestamp,
    });
    res.status(201).json({ success: true, data: { message: chatMessage } });
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
