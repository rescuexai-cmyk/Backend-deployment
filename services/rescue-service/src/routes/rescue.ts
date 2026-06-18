import express, { Response } from 'express';
import { body, query, param, validationResult } from 'express-validator';
import { authenticate, AuthRequest } from '@raahi/shared';
import { asyncHandler } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import { canDriverStartRides, DRIVER_NOT_VERIFIED_RIDE_ERROR } from '@raahi/shared';
import * as rescueService from '../rescueService';

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
 *         pickupAddress:
 *           type: string
 *         dropAddress:
 *           type: string
 *         hasVehicle:
 *           type: boolean
 *         vehicleType:
 *           type: string
 *           enum: [TWO_WHEELER, FOUR_WHEELER]
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
 */

// ─── CREATE RESCUE REQUEST ────────────────────────────────────────────────────

/**
 * @openapi
 * /api/rescue:
 *   post:
 *     tags: [Rescue]
 *     summary: Create a new rescue request
 *     description: |
 *       User requests a rescue with pickup and drop addresses.
 *       Optionally, the user can indicate they have a vehicle that also needs to be transported.
 *       If hasVehicle is true, vehicleType (TWO_WHEELER or FOUR_WHEELER) is required.
 *       The system will dispatch the appropriate number of rescue drivers (1 or 2).
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
 *               paymentMethod:
 *                 type: string
 *                 enum: [CASH, CARD, UPI, WALLET]
 *               hasVehicle:
 *                 type: boolean
 *               vehicleType:
 *                 type: string
 *                 enum: [TWO_WHEELER, FOUR_WHEELER]
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
    body('vehicleType').optional().isIn(['TWO_WHEELER', 'FOUR_WHEELER']),
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

export default router;
