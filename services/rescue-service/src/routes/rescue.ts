import express, { Response } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { authenticate, AuthRequest } from '@raahi/shared';
import { asyncHandler } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import { canDriverStartRides, DRIVER_NOT_VERIFIED_RIDE_ERROR } from '@raahi/shared';
import * as rescueService from '../rescueService';
import fs from 'fs';
import path from 'path';
import * as storage from '../storage';

const router = express.Router();

// ─── Swagger Component Schemas ────────────────────────────────────────────────

/**
 * @openapi
 * components:
 *   schemas:
 *     RescueRequest:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         userId:
 *           type: string
 *         rescueServiceType:
 *           type: string
 *           enum: [TRAFFIC_RESCUE, VEHICLE_RESCUE, PASSENGER_VEHICLE_RESCUE, BREAKDOWN_RESCUE, EMERGENCY_ASSISTANCE]
 *         reason:
 *           type: string
 *         pickupAddress:
 *           type: string
 *         dropAddress:
 *           type: string
 *         hasVehicle:
 *           type: boolean
 *         vehicleType:
 *           type: string
 *           enum: [TWO_WHEELER, FOUR_WHEELER]
 *         vehicleSubType:
 *           type: string
 *           enum: [BIKE, SCOOTER, HATCHBACK, SEDAN, SUV]
 *         vehicleRegistrationNumber:
 *           type: string
 *         vehicleTransmission:
 *           type: string
 *           enum: [MANUAL, AUTOMATIC]
 *         vehicleIssues:
 *           type: array
 *           items:
 *             type: string
 *         vehicleDropAddress:
 *           type: string
 *         status:
 *           type: string
 *           enum: [PENDING, DRIVER1_ACCEPTED, BOTH_ACCEPTED, DRIVERS_EN_ROUTE, DRIVERS_ARRIVED, IN_PROGRESS, COMPLETED, CANCELLED]
 *         rescueStage:
 *           type: integer
 *         driver1:
 *           type: object
 *         driver2:
 *           type: object
 *         userRideId:
 *           type: string
 *         vehicleRideId:
 *           type: string
 *         estimatedPassengerFare:
 *           type: number
 *         estimatedVehicleFare:
 *           type: number
 *         estimatedPlatformFee:
 *           type: number
 *         estimatedInsuranceFee:
 *           type: number
 *         estimatedTotalFare:
 *           type: number
 *     RescueTimelineEvent:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         event:
 *           type: string
 *         title:
 *           type: string
 *         description:
 *           type: string
 *         actor:
 *           type: string
 *         createdAt:
 *           type: string
 *           format: date-time
 *     RescueFareEstimate:
 *       type: object
 *       properties:
 *         breakdown:
 *           type: object
 *           properties:
 *             passengerTransport:
 *               type: object
 *               properties:
 *                 label:
 *                   type: string
 *                 amount:
 *                   type: number
 *             vehicleDelivery:
 *               type: object
 *               nullable: true
 *             platformFee:
 *               type: object
 *             insurance:
 *               type: object
 *         total:
 *           type: number
 *         currency:
 *           type: string
 */

// ─── GET ACTIVE RESCUE (must be before /:id routes) ──────────────────────────

/**
 * @openapi
 * /api/rescue/active:
 *   get:
 *     tags: [Rescue]
 *     summary: Get user's current active rescue request
 *     description: |
 *       Returns the user's ongoing rescue (if any). Used by the app to resume
 *       tracking after app reopen or backgrounding. Returns null if no active rescue.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active rescue or null
 */
router.get('/active', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const rescue = await rescueService.getActiveRescue(req.user!.id);
  res.status(200).json({ success: true, data: rescue });
}));

// ─── RESCUE FARE ESTIMATE ────────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/estimate:
 *   post:
 *     tags: [Rescue]
 *     summary: Get rescue fare estimate with detailed breakdown
 *     description: |
 *       Returns per-line pricing for the Review & Confirm screen:
 *       - Passenger transport fare
 *       - Vehicle delivery fare (if applicable)
 *       - Platform fee
 *       - Insurance fee
 *       - Total estimated fare
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pickupLat, pickupLng, dropLat, dropLng, hasVehicle]
 *             properties:
 *               pickupLat:
 *                 type: number
 *               pickupLng:
 *                 type: number
 *               dropLat:
 *                 type: number
 *               dropLng:
 *                 type: number
 *               hasVehicle:
 *                 type: boolean
 *               vehicleDropLat:
 *                 type: number
 *               vehicleDropLng:
 *                 type: number
 *               vehicleDropSameAsDrop:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Fare estimate with breakdown
 */
router.post(
  '/estimate',
  authenticate,
  [
    body('pickupLat').isFloat({ min: -90, max: 90 }),
    body('pickupLng').isFloat({ min: -180, max: 180 }),
    body('dropLat').isFloat({ min: -90, max: 90 }),
    body('dropLng').isFloat({ min: -180, max: 180 }),
    body('hasVehicle').isBoolean(),
    body('vehicleDropLat').optional().isFloat({ min: -90, max: 90 }),
    body('vehicleDropLng').optional().isFloat({ min: -180, max: 180 }),
    body('vehicleDropSameAsDrop').optional().isBoolean(),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const estimate = await rescueService.getRescueFareEstimate(req.body);
    res.status(200).json({ success: true, data: estimate });
  })
);

// ─── CREATE RESCUE REQUEST ────────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue:
 *   post:
 *     tags: [Rescue]
 *     summary: Create a new rescue request
 *     description: |
 *       User requests a rescue with full details from Screens ①–⑤:
 *       - Service type (traffic, vehicle, passenger+vehicle, breakdown, emergency)
 *       - What's happening reason
 *       - Pickup/drop locations
 *       - Vehicle details (type, registration, transmission, issues)
 *       - Vehicle drop location
 *       The system calculates fare estimates and dispatches rescue drivers.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pickupLat, pickupLng, pickupAddress, dropLat, dropLng, dropAddress, paymentMethod, hasVehicle]
 *             properties:
 *               rescueServiceType:
 *                 type: string
 *                 enum: [TRAFFIC_RESCUE, VEHICLE_RESCUE, PASSENGER_VEHICLE_RESCUE, BREAKDOWN_RESCUE, EMERGENCY_ASSISTANCE]
 *               reason:
 *                 type: string
 *                 description: "stuck_in_traffic, need_vehicle_delivered, feeling_unsafe, driver_unavailable, long_parking_walk, vehicle_not_starting, other"
 *               reasonDetails:
 *                 type: string
 *                 description: Free-text for "Other" reason
 *               pickupLat:
 *                 type: number
 *               pickupLng:
 *                 type: number
 *               pickupAddress:
 *                 type: string
 *               dropLat:
 *                 type: number
 *               dropLng:
 *                 type: number
 *               dropAddress:
 *                 type: string
 *               isVehicleWithUser:
 *                 type: boolean
 *               paymentMethod:
 *                 type: string
 *                 enum: [CASH, CARD, UPI, WALLET]
 *               hasVehicle:
 *                 type: boolean
 *               vehicleType:
 *                 type: string
 *                 enum: [TWO_WHEELER, FOUR_WHEELER]
 *               vehicleSubType:
 *                 type: string
 *                 enum: [BIKE, SCOOTER, HATCHBACK, SEDAN, SUV]
 *               vehicleRegistrationNumber:
 *                 type: string
 *                 description: "e.g. MP04 XX 1234"
 *               vehicleRegistrationState:
 *                 type: string
 *                 description: "State code, e.g. MP"
 *               vehicleTransmission:
 *                 type: string
 *                 enum: [MANUAL, AUTOMATIC]
 *               vehicleIssues:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: "flat_tyre, overheating, damage, engine_failure, battery_dead"
 *               vehicleDropAddress:
 *                 type: string
 *               vehicleDropLat:
 *                 type: number
 *               vehicleDropLng:
 *                 type: number
 *               vehicleDropSameAsDrop:
 *                 type: boolean
 *     responses:
 *       201:
 *         description: Rescue request created successfully
 *       400:
 *         description: Validation failed
 */
router.post(
  '/',
  authenticate,
  [
    body('pickupLat').isFloat({ min: -90, max: 90 }),
    body('pickupLng').isFloat({ min: -180, max: 180 }),
    body('pickupAddress').isString().notEmpty(),
    body('dropLat').isFloat({ min: -90, max: 90 }),
    body('dropLng').isFloat({ min: -180, max: 180 }),
    body('dropAddress').isString().notEmpty(),
    body('paymentMethod').isIn(['CASH', 'CARD', 'UPI', 'WALLET']),
    body('hasVehicle').isBoolean(),
    // New optional fields
    body('rescueServiceType').optional().isIn([
      'TRAFFIC_RESCUE', 'VEHICLE_RESCUE', 'PASSENGER_VEHICLE_RESCUE',
      'BREAKDOWN_RESCUE', 'EMERGENCY_ASSISTANCE',
    ]),
    body('reason').optional().isString(),
    body('reasonDetails').optional().isString(),
    body('isVehicleWithUser').optional().isBoolean(),
    body('vehicleType').optional().isIn(['TWO_WHEELER', 'FOUR_WHEELER']),
    body('vehicleSubType').optional().isIn(['BIKE', 'SCOOTER', 'HATCHBACK', 'SEDAN', 'SUV']),
    body('vehicleRegistrationNumber').optional().isString().trim(),
    body('vehicleRegistrationState').optional().isString().trim(),
    body('vehicleTransmission').optional().isIn(['MANUAL', 'AUTOMATIC']),
    body('vehicleIssues').optional().isArray(),
    body('vehicleDropAddress').optional().isString(),
    body('vehicleDropLat').optional().isFloat({ min: -90, max: 90 }),
    body('vehicleDropLng').optional().isFloat({ min: -180, max: 180 }),
    body('vehicleDropSameAsDrop').optional().isBoolean(),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const {
      pickupLat, pickupLng, pickupAddress,
      dropLat, dropLng, dropAddress,
      paymentMethod, hasVehicle, vehicleType,
      vehicleDropAddress, vehicleDropLat, vehicleDropLng,
      vehicleDropSameAsDrop,
      // New fields
      rescueServiceType, reason, reasonDetails,
      isVehicleWithUser, vehicleSubType,
      vehicleRegistrationNumber, vehicleRegistrationState,
      vehicleTransmission, vehicleIssues,
    } = req.body;

    // Validate vehicle fields when hasVehicle is true
    if (hasVehicle && !vehicleType) {
      res.status(400).json({
        success: false,
        message: 'vehicleType is required when hasVehicle is true',
      });
      return;
    }

    if (hasVehicle && !vehicleDropSameAsDrop && (!vehicleDropLat || !vehicleDropLng || !vehicleDropAddress)) {
      res.status(400).json({
        success: false,
        message: 'Vehicle drop location is required when hasVehicle is true and vehicleDropSameAsDrop is false',
      });
      return;
    }

    const rescue = await rescueService.createRescueRequest({
      userId: req.user!.id,
      pickupLat, pickupLng, pickupAddress,
      dropLat, dropLng, dropAddress,
      paymentMethod,
      hasVehicle,
      vehicleType,
      vehicleDropAddress,
      vehicleDropLat,
      vehicleDropLng,
      vehicleDropSameAsDrop,
      // New fields
      rescueServiceType,
      reason,
      reasonDetails,
      isVehicleWithUser,
      vehicleSubType,
      vehicleRegistrationNumber,
      vehicleRegistrationState,
      vehicleTransmission,
      vehicleIssues,
    });

    res.status(201).json({ success: true, message: 'Rescue request created successfully', data: rescue });
  })
);

// ─── LIST USER'S RESCUE REQUESTS ──────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue:
 *   get:
 *     tags: [Rescue]
 *     summary: List user's rescue history
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
 *         description: List of rescue requests
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
    const result = await rescueService.getUserRescueHistory(req.user!.id, page, limit);
    res.status(200).json({ success: true, data: result });
  })
);

// ─── GET RESCUE REQUEST BY ID ─────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}:
 *   get:
 *     tags: [Rescue]
 *     summary: Get rescue request details
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
 *         description: Rescue request details
 *       404:
 *         description: Rescue request not found
 */
router.get('/:id', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const rescue = await rescueService.getRescueById(req.params.id, req.user!.id);
  if (!rescue) {
    res.status(404).json({ success: false, message: 'Rescue request not found' });
    return;
  }

  // Access check: user, driver1, or driver2
  let isDriver = false;
  const driver = await prisma.driver.findUnique({
    where: { userId: req.user!.id },
    select: { id: true },
  });
  if (driver && (rescue.driver1Id === driver.id || rescue.driver2Id === driver.id)) {
    isDriver = true;
  }

  if (rescue.userId !== req.user!.id && !isDriver) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  res.status(200).json({ success: true, data: rescue });
}));

// ─── GET RESCUE TIMELINE ─────────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/timeline:
 *   get:
 *     tags: [Rescue]
 *     summary: Get rescue timeline events
 *     description: |
 *       Returns chronological list of all events for a rescue journey.
 *       Powers the Timeline tab in the Journey Hub (Screen ⑨).
 *       Events include: request created, driver assigned, en-route, arrived,
 *       OTP verified, ride started, vehicle delivered, rescue completed, etc.
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
 *         description: List of timeline events
 *       404:
 *         description: Rescue request not found
 */
router.get('/:id/timeline', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  // Access check
  const rescue = await rescueService.getRescueById(req.params.id, req.user!.id);
  if (!rescue) {
    res.status(404).json({ success: false, message: 'Rescue request not found' });
    return;
  }

  let hasAccess = rescue.userId === req.user!.id;
  if (!hasAccess) {
    const driver = await prisma.driver.findUnique({
      where: { userId: req.user!.id },
      select: { id: true },
    });
    if (driver && (rescue.driver1Id === driver.id || rescue.driver2Id === driver.id)) {
      hasAccess = true;
    }
  }

  if (!hasAccess) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }

  const timeline = await rescueService.getRescueTimeline(req.params.id);
  res.status(200).json({ success: true, data: timeline });
}));

// ─── DRIVER ACCEPTS RESCUE ───────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/accept:
 *   post:
 *     tags: [Rescue]
 *     summary: Driver accepts a rescue request
 *     description: |
 *       For single-driver rescue (no vehicle): driver is assigned immediately.
 *       For dual-driver rescue (has vehicle): first driver becomes driver1, second becomes driver2.
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
 *         description: Rescue accepted
 *       403:
 *         description: Driver not verified
 *       409:
 *         description: Rescue already fully accepted
 */
router.post('/:id/accept', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const rescueId = req.params.id;
  const userId = req.user!.id;

  console.log(`[RESCUE_ACCEPT] Rescue: ${rescueId}, User: ${userId}`);

  // Get driver profile
  const driver = await prisma.driver.findUnique({
    where: { userId },
    select: { id: true, isVerified: true, isOnline: true, isActive: true, onboardingStatus: true },
  });

  if (!driver) {
    res.status(403).json({ success: false, message: 'Driver access required', code: 'FORBIDDEN' });
    return;
  }

  if (!canDriverStartRides(driver)) {
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

  try {
    const rescue = await rescueService.driverAcceptRescue(rescueId, driver.id);
    res.status(200).json({ success: true, message: 'Rescue accepted successfully', data: rescue });
  } catch (error: any) {
    if (error.message?.includes('already accepted') || error.message?.includes('already been accepted')) {
      res.status(409).json({ success: false, message: error.message, code: 'ALREADY_ACCEPTED' });
      return;
    }
    if (error.message?.includes('not found')) {
      res.status(404).json({ success: false, message: error.message, code: 'NOT_FOUND' });
      return;
    }
    if (error.message?.includes('not verified')) {
      res.status(403).json({ success: false, message: error.message, code: 'NOT_VERIFIED' });
      return;
    }
    throw error;
  }
}));

// ─── DRIVER EN ROUTE (Driver 1 picked up Driver 2) ───────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/driver-enroute:
 *   post:
 *     tags: [Rescue]
 *     summary: Driver 1 has picked up Driver 2 and is heading to user
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
 *         description: Status updated to en-route
 */
router.post('/:id/driver-enroute', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const driver = await prisma.driver.findUnique({
    where: { userId: req.user!.id },
    select: { id: true },
  });

  if (!driver) {
    res.status(403).json({ success: false, message: 'Driver access required' });
    return;
  }

  try {
    const rescue = await rescueService.driversEnRoute(req.params.id, driver.id);
    res.status(200).json({ success: true, message: 'Drivers en route to user', data: rescue });
  } catch (error: any) {
    if (error.message?.includes('not found')) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    throw error;
  }
}));

// ─── DRIVERS ARRIVED AT USER ─────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/arrived:
 *   post:
 *     tags: [Rescue]
 *     summary: Drivers have arrived at user's pickup location
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
 *         description: Status updated to arrived
 */
router.post('/:id/arrived', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const driver = await prisma.driver.findUnique({
    where: { userId: req.user!.id },
    select: { id: true },
  });

  if (!driver) {
    res.status(403).json({ success: false, message: 'Driver access required' });
    return;
  }

  try {
    const rescue = await rescueService.driversArrived(req.params.id, driver.id);
    res.status(200).json({ success: true, message: 'Drivers arrived at user location', data: rescue });
  } catch (error: any) {
    if (error.message?.includes('not found')) {
      res.status(404).json({ success: false, message: error.message });
      return;
    }
    throw error;
  }
}));

// ─── VERIFY OTP AND START RIDES ──────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/verify-otp:
 *   post:
 *     tags: [Rescue]
 *     summary: Verify rescue OTP and start rides
 *     description: |
 *       Driver verifies the OTP shared by the user. On successful verification,
 *       the system creates Ride records and starts them:
 *       - User Ride: Driver 1 takes user to their destination
 *       - Vehicle Ride (if applicable): Driver 2 takes vehicle to vehicle drop destination
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
 *             required: [otp]
 *             properties:
 *               otp:
 *                 type: string
 *                 minLength: 4
 *                 maxLength: 4
 *     responses:
 *       200:
 *         description: OTP verified, rides started
 *       400:
 *         description: Invalid OTP
 */
router.post(
  '/:id/verify-otp',
  authenticate,
  [body('otp').isString().isLength({ min: 4, max: 4 })],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'OTP must be 4 digits', errors: errors.array() });
      return;
    }

    const driver = await prisma.driver.findUnique({
      where: { userId: req.user!.id },
      select: { id: true },
    });

    if (!driver) {
      res.status(403).json({ success: false, message: 'Driver access required' });
      return;
    }

    try {
      const rescue = await rescueService.verifyOtpAndStartRides(req.params.id, driver.id, req.body.otp);
      res.status(200).json({ success: true, message: 'OTP verified, rides started', data: rescue });
    } catch (error: any) {
      if (error.message?.includes('Invalid OTP')) {
        res.status(400).json({ success: false, message: error.message, code: 'INVALID_OTP' });
        return;
      }
      if (error.message?.includes('not found')) {
        res.status(404).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }
  })
);

// ─── CANCEL RESCUE ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/cancel:
 *   post:
 *     tags: [Rescue]
 *     summary: Cancel a rescue request
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Rescue cancelled
 */
router.post(
  '/:id/cancel',
  authenticate,
  [body('reason').optional().isString()],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const rescueId = req.params.id;
    const userId = req.user!.id;
    const reason = req.body.reason;

    // Determine if canceller is passenger or driver
    let cancelledBy = 'passenger';
    const driver = await prisma.driver.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (driver) {
      // Check if this driver is assigned to the rescue
      const rescue = await (prisma as any).rescueRequest.findUnique({
        where: { id: rescueId },
        select: { driver1Id: true, driver2Id: true, userId: true },
      });

      if (rescue && (rescue.driver1Id === driver.id || rescue.driver2Id === driver.id)) {
        cancelledBy = 'driver';
      }
    }

    try {
      const rescue = await rescueService.cancelRescue(rescueId, cancelledBy, reason);
      res.status(200).json({ success: true, message: 'Rescue cancelled successfully', data: rescue });
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        res.status(404).json({ success: false, message: error.message });
        return;
      }
      if (error.message?.includes('Cannot cancel')) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }
  })
);

// ─── SOS / EMERGENCY ─────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/sos:
 *   post:
 *     tags: [Rescue]
 *     summary: Trigger SOS / Emergency during a rescue
 *     description: |
 *       User taps the SOS button to alert the support team and drivers.
 *       This marks the rescue as SOS-triggered and sends high-priority
 *       notifications to all assigned drivers and the admin team.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *                 description: Optional notes about the emergency
 *     responses:
 *       200:
 *         description: SOS triggered, all parties notified
 *       400:
 *         description: Cannot trigger SOS for this rescue status
 */
router.post(
  '/:id/sos',
  authenticate,
  [body('notes').optional().isString().isLength({ max: 1000 })],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    try {
      const rescue = await rescueService.triggerSOS(req.params.id, req.user!.id, req.body.notes);
      res.status(200).json({ success: true, message: 'SOS triggered — support team has been alerted', data: rescue });
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        res.status(404).json({ success: false, message: error.message });
        return;
      }
      if (error.message?.includes('Cannot trigger') || error.message?.includes('Only the rescue user')) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }
  })
);

// ─── VEHICLE DELIVERY VERIFICATION ──────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/vehicle-delivery:
 *   post:
 *     tags: [Rescue]
 *     summary: Verify vehicle delivery condition
 *     description: |
 *       After the vehicle is delivered (Screen ⑩), user can:
 *       - Accept: "Looks good, Accept" — confirms vehicle received in good condition
 *       - Report Issue: "Report an Issue" — flags damage or problems with condition photos
 *       
 *       Frontend uploads photos to cloud storage and sends URLs here.
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
 *             required: [status]
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [ACCEPTED, ISSUE_REPORTED]
 *               conditionPhotos:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: URLs of vehicle condition photos
 *               notes:
 *                 type: string
 *                 description: Optional notes on vehicle condition
 *               issue:
 *                 type: string
 *                 description: Issue description (required when status is ISSUE_REPORTED)
 *     responses:
 *       200:
 *         description: Vehicle delivery verified
 *       400:
 *         description: Invalid request
 */
router.post(
  '/:id/vehicle-delivery',
  authenticate,
  [
    body('status').isIn(['ACCEPTED', 'ISSUE_REPORTED']),
    body('conditionPhotos').optional().isArray(),
    body('conditionPhotos.*').optional().isURL(),
    body('notes').optional().isString().isLength({ max: 1000 }),
    body('issue').optional().isString().isLength({ max: 1000 }),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    // If reporting issue, require issue description
    if (req.body.status === 'ISSUE_REPORTED' && !req.body.issue) {
      res.status(400).json({ success: false, message: 'Issue description is required when reporting an issue' });
      return;
    }

    try {
      const rescue = await rescueService.verifyVehicleDelivery(req.params.id, req.user!.id, req.body);
      res.status(200).json({
        success: true,
        message: req.body.status === 'ACCEPTED'
          ? 'Vehicle delivery accepted'
          : 'Issue reported — our team will follow up',
        data: rescue,
      });
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        res.status(404).json({ success: false, message: error.message });
        return;
      }
      if (error.message?.includes('not include') || error.message?.includes('Only the rescue user') || error.message?.includes('Cannot verify')) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }
  })
);

// ─── SUBMIT RESCUE RATINGS ──────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/rate:
 *   post:
 *     tags: [Rescue]
 *     summary: Submit multi-party rescue ratings
 *     description: |
 *       After rescue completion (Screen ⑪), user rates each party separately:
 *       - RIDER_DRIVER: The driver who transported the passenger
 *       - VEHICLE_DRIVER: The driver who transported the vehicle (if applicable)
 *       - SUPPORT: Overall support experience
 *       
 *       Also includes "Was your problem solved?" boolean.
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
 *             required: [ratings]
 *             properties:
 *               ratings:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [targetType, rating]
 *                   properties:
 *                     targetType:
 *                       type: string
 *                       enum: [RIDER_DRIVER, VEHICLE_DRIVER, SUPPORT]
 *                     rating:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 5
 *                     feedback:
 *                       type: string
 *               problemSolved:
 *                 type: boolean
 *                 description: "Was your problem solved?"
 *     responses:
 *       200:
 *         description: Ratings submitted
 *       400:
 *         description: Invalid ratings
 */
router.post(
  '/:id/rate',
  authenticate,
  [
    body('ratings').isArray({ min: 1 }),
    body('ratings.*.targetType').isIn(['RIDER_DRIVER', 'VEHICLE_DRIVER', 'SUPPORT']),
    body('ratings.*.rating').isInt({ min: 1, max: 5 }),
    body('ratings.*.feedback').optional().isString().isLength({ max: 500 }),
    body('problemSolved').optional().isBoolean(),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    try {
      const result = await rescueService.submitRescueRating(req.params.id, req.user!.id, req.body);
      res.status(200).json({ success: true, message: 'Ratings submitted — thank you!', data: result });
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        res.status(404).json({ success: false, message: error.message });
        return;
      }
      if (error.message?.includes('Only the rescue user') || error.message?.includes('Can only rate')) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }
  })
);

// ─── REPORT ISSUE ───────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/report-issue:
 *   post:
 *     tags: [Rescue]
 *     summary: Report an issue with a rescue
 *     description: |
 *       User can report issues after rescue (Screen ⑪ "Report an Issue").
 *       Creates a high-priority support ticket for the operations team.
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
 *             required: [issueType, description]
 *             properties:
 *               issueType:
 *                 type: string
 *                 description: "VEHICLE_DAMAGE, DRIVER_BEHAVIOR, PRICING, ROUTE, SAFETY, OTHER"
 *               description:
 *                 type: string
 *               photos:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Issue reported, support ticket created
 */
router.post(
  '/:id/report-issue',
  authenticate,
  [
    body('issueType').isString().notEmpty(),
    body('description').isString().notEmpty().isLength({ max: 2000 }),
    body('photos').optional().isArray(),
    body('photos.*').optional().isURL(),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    try {
      const result = await rescueService.reportRescueIssue(
        req.params.id,
        req.user!.id,
        req.body.issueType,
        req.body.description,
        req.body.photos
      );
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      if (error.message?.includes('not found')) {
        res.status(404).json({ success: false, message: error.message });
        return;
      }
      if (error.message?.includes('Only the rescue user')) {
        res.status(403).json({ success: false, message: error.message });
        return;
      }
      throw error;
    }
  })
);

// ─── GET RESCUE PROGRESS (Progressive Ride Tracking) ─────────────────────────

/**
 * @openapi
 * /api/rescue/{id}/progress:
 *   get:
 *     tags: [Rescue]
 *     summary: Get progressive ride tracking for rescue
 *     description: |
 *       Returns the current status and location of both rides:
 *       - User ride (Driver 1 → user destination)
 *       - Vehicle ride (Driver 2 → vehicle destination)
 *       User can track both rides simultaneously.
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
 *         description: Rescue progress with both ride tracking
 *       404:
 *         description: Rescue request not found
 */
router.get('/:id/progress', authenticate, asyncHandler(async (req: AuthRequest, res: Response) => {
  const progress = await rescueService.getRescueProgress(req.params.id);
  if (!progress) {
    res.status(404).json({ success: false, message: 'Rescue request not found' });
    return;
  }

  // Only the user who created the rescue can view progress
  if (progress.rescue.userId !== req.user!.id) {
    // Allow assigned drivers too
    const driver = await prisma.driver.findUnique({
      where: { userId: req.user!.id },
      select: { id: true },
    });
    if (!driver || (progress.rescue.driver1Id !== driver.id && progress.rescue.driver2Id !== driver.id)) {
      res.status(403).json({ success: false, message: 'Access denied' });
      return;
    }
  }

  res.status(200).json({ success: true, data: progress });
}));

// ─── INTERNAL: Ride completion callback ──────────────────────────────────────

/**
 * Internal endpoint called when a ride is completed, to check if rescue is done
 */
router.post('/internal/ride-completed', asyncHandler(async (req: AuthRequest, res: Response) => {
  const internalKey = req.headers['x-internal-api-key'];
  if (internalKey !== (process.env.INTERNAL_API_KEY || 'raahi-internal-service-key')) {
    res.status(403).json({ success: false, message: 'Internal access only' });
    return;
  }

  const { rideId } = req.body;
  if (!rideId) {
    res.status(400).json({ success: false, message: 'rideId is required' });
    return;
  }

  const result = await rescueService.checkAndCompleteRescue(rideId);
  res.status(200).json({ success: true, data: result });
}));

// ─── PHOTO UPLOAD SUPPORT ────────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue/upload-url:
 *   post:
 *     tags: [Rescue]
 *     summary: Get a presigned upload URL for S3 or local development fallback
 *     description: |
 *       Generates a presigned upload PUT URL for uploading photo files.
 *       If S3 is not configured, returns a local fallback endpoint.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fileName, contentType]
 *             properties:
 *               fileName:
 *                 type: string
 *                 example: condition_before.jpg
 *               contentType:
 *                 type: string
 *                 example: image/jpeg
 *               rescueId:
 *                 type: string
 *                 example: cljabc1230000ud8gxxxxxxx
 *               photoType:
 *                 type: string
 *                 example: condition
 *     responses:
 *       200:
 *         description: Presigned upload URL generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     uploadUrl:
 *                       type: string
 *                     downloadUrl:
 *                       type: string
 *                     key:
 *                       type: string
 */
router.post(
  '/upload-url',
  authenticate,
  [
    body('fileName').isString().notEmpty(),
    body('contentType').isString().notEmpty(),
    body('rescueId').optional().isString(),
    body('photoType').optional().isString(),
  ],
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { fileName, contentType, rescueId, photoType } = req.body;
    
    // Sanitize fileName to prevent directory traversal
    const safeFileName = path.basename(fileName);
    const folder = rescueId ? `rescue/${rescueId}` : 'rescue/general';
    const subFolder = photoType ? `${photoType}/` : '';
    const key = `${folder}/${subFolder}${Date.now()}_${safeFileName}`;

    if (storage.isS3Configured()) {
      const uploadUrl = await storage.generatePresignedUploadUrl(key, contentType);
      if (!uploadUrl) {
        res.status(500).json({ success: false, message: 'Failed to generate upload URL' });
        return;
      }
      const downloadUrl = storage.getPublicUrl(key);
      res.status(200).json({
        success: true,
        data: { uploadUrl, downloadUrl, key }
      });
    } else {
      // Local fallback
      const host = req.get('host') || 'localhost:5009';
      const protocol = req.protocol || 'http';
      const uploadUrl = `${protocol}://${host}/api/rescue/upload-local?key=${encodeURIComponent(key)}`;
      const downloadUrl = `${protocol}://${host}${storage.getPublicUrl(key)}`;

      res.status(200).json({
        success: true,
        data: { uploadUrl, downloadUrl, key }
      });
    }
  })
);

/**
 * @openapi
 * /api/rescue/upload-local:
 *   put:
 *     tags: [Rescue]
 *     summary: Local disk fallback endpoint to upload raw file body bytes
 *     description: |
 *       Saves raw request body bytes to local disk storage at the path specified by the key parameter.
 *       Only used when S3 is not configured.
 *     parameters:
 *       - in: query
 *         name: key
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File uploaded successfully
 */
router.put(
  '/upload-local',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const keyParam = req.query.key as string;
    if (!keyParam) {
      res.status(400).json({ success: false, message: 'Missing key parameter' });
      return;
    }

    // Sanitize path to prevent directory traversal
    const cleanKey = path.normalize(keyParam).replace(/^(\.\.(\/|\\|$))+/, '');
    const uploadsBaseDir = path.join(process.cwd(), 'uploads');
    const filePath = path.join(uploadsBaseDir, cleanKey);

    // Ensure parent directory exists
    const parentDir = path.dirname(filePath);
    if (!parentDir.startsWith(uploadsBaseDir)) {
      res.status(400).json({ success: false, message: 'Invalid path key' });
      return;
    }

    await fs.promises.mkdir(parentDir, { recursive: true });

    // Stream body directly to file
    const writeStream = fs.createWriteStream(filePath);
    req.pipe(writeStream);

    writeStream.on('finish', () => {
      res.status(200).json({ success: true, message: 'File uploaded successfully' });
    });

    writeStream.on('error', (err) => {
      res.status(500).json({ success: false, message: 'Failed to write file', error: err.message });
    });
  })
);

export default router;
