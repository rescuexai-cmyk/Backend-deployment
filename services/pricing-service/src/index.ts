import express from 'express';
import cors from 'cors';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, optionalAuth, authenticate, errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { calculateFare, calculateAllFares, finalizeFare, getNearbyDrivers, getPricingRules } from './pricingService';
import { validatePromo, calculatePromoDiscount, getActivePromosForUser } from './promoService';

const logger = createLogger('pricing-service');
const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'pricing-service', timestamp: new Date().toISOString() });
});

/**
 * POST /api/pricing/calculate
 * Calculate fare for a single vehicle type (defaults to "cab").
 */
app.post(
  '/api/pricing/calculate',
  [
    body('pickupLat').isFloat({ min: -90, max: 90 }),
    body('pickupLng').isFloat({ min: -180, max: 180 }),
    body('dropLat').isFloat({ min: -90, max: 90 }),
    body('dropLng').isFloat({ min: -180, max: 180 }),
    body('vehicleType').optional().isString(),
    body('scheduledTime').optional().isISO8601(),
  ],
  optionalAuth,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { pickupLat, pickupLng, dropLat, dropLng, vehicleType, scheduledTime } = req.body;
    const pricing = await calculateFare({
      pickupLat,
      pickupLng,
      dropLat,
      dropLng,
      vehicleType,
      scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
    });
    res.status(200).json({ success: true, data: pricing });
  })
);

/**
 * POST /api/pricing/calculate-all
 * Calculate fares for ALL vehicle types in one call.
 */
app.post(
  '/api/pricing/calculate-all',
  [
    body('pickupLat').isFloat({ min: -90, max: 90 }),
    body('pickupLng').isFloat({ min: -180, max: 180 }),
    body('dropLat').isFloat({ min: -90, max: 90 }),
    body('dropLng').isFloat({ min: -180, max: 180 }),
    body('scheduledTime').optional().isISO8601(),
  ],
  optionalAuth,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { pickupLat, pickupLng, dropLat, dropLng, scheduledTime } = req.body;
    const allFares = await calculateAllFares(
      pickupLat,
      pickupLng,
      dropLat,
      dropLng,
      scheduledTime ? new Date(scheduledTime) : undefined
    );
    res.status(200).json({ success: true, data: allFares });
  })
);

/**
 * POST /api/pricing/finalize
 * Compute final fare post-ride (Algorithm 3).
 */
app.post(
  '/api/pricing/finalize',
  [
    body('rideId').isString().notEmpty(),
    body('dynamicFare').isFloat({ min: 0 }),
    body('vehicleType').optional().isString(),
    body('city').optional().isString(),
    body('pickupLat').optional().isFloat({ min: -90, max: 90 }),
    body('pickupLng').optional().isFloat({ min: -180, max: 180 }),
    body('dropLat').optional().isFloat({ min: -90, max: 90 }),
    body('dropLng').optional().isFloat({ min: -180, max: 180 }),
    body('tolls').optional().isFloat({ min: 0 }),
    body('waitingMinutes').optional().isFloat({ min: 0 }),
    body('hasAirportPickup').optional().isBoolean(),
    body('parkingFees').optional().isFloat({ min: 0 }),
    body('extraStopsCount').optional().isInt({ min: 0 }),
    body('discountPercent').optional().isFloat({ min: 0, max: 100 }),
    body('discountAmount').optional().isFloat({ min: 0 }),
  ],
  optionalAuth,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const body = req.body;
    const result = await finalizeFare({
      rideId: body.rideId,
      dynamicFare: body.dynamicFare,
      vehicleType: body.vehicleType,
      city: body.city,
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      dropLat: body.dropLat,
      dropLng: body.dropLng,
      tolls: body.tolls,
      waitingMinutes: body.waitingMinutes,
      hasAirportPickup: body.hasAirportPickup,
      parkingFees: body.parkingFees,
      extraStopsCount: body.extraStopsCount,
      discountPercent: body.discountPercent,
      discountAmount: body.discountAmount,
    });
    res.status(200).json({ success: true, data: result });
  })
);

/**
 * GET /api/pricing/nearby-drivers
 */
app.get(
  '/api/pricing/nearby-drivers',
  [
    query('lat').isFloat({ min: -90, max: 90 }),
    query('lng').isFloat({ min: -180, max: 180 }),
    query('radius').optional().isFloat({ min: 1, max: 50 }),
    query('vehicleType').optional().isString(),
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
    const vehicleType = req.query.vehicleType as string | undefined;
    const drivers = await getNearbyDrivers(lat, lng, radius, vehicleType);
    res.status(200).json({ success: true, data: { drivers, count: drivers.length, radius } });
  })
);

/**
 * GET /api/pricing/rules
 * Returns current pricing configuration (rates, fees, flags).
 */
app.get('/api/pricing/rules', asyncHandler(async (_req, res) => {
  const rules = getPricingRules();
  res.status(200).json({ success: true, data: rules });
}));

// ============================================================
// Promo endpoints
// ============================================================

/**
 * POST /api/promo/validate
 * Validate a promo code for a user
 */
app.post(
  '/api/promo/validate',
  [
    body('code').isString().notEmpty().trim(),
    body('vehicleType').optional().isString(),
    body('city').optional().isString(),
    body('fare').optional().isFloat({ min: 0 }),
  ],
  authenticate,
  asyncHandler(async (req: any, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { code, vehicleType, city, fare } = req.body;
    const userId = req.user.id;
    
    const result = await validatePromo({ code, userId, vehicleType, city, fare });
    
    if (!result.valid) {
      res.status(400).json({ success: false, message: result.error });
      return;
    }
    
    res.status(200).json({ success: true, data: result.promo });
  })
);

/**
 * POST /api/promo/apply
 * Calculate discount for a validated promo
 */
app.post(
  '/api/promo/apply',
  [
    body('code').isString().notEmpty().trim(),
    body('fare').isFloat({ min: 0 }),
    body('vehicleType').optional().isString(),
    body('city').optional().isString(),
  ],
  authenticate,
  asyncHandler(async (req: any, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { code, fare, vehicleType, city } = req.body;
    const userId = req.user.id;
    
    // First validate the promo
    const validation = await validatePromo({ code, userId, vehicleType, city, fare });
    
    if (!validation.valid || !validation.promo) {
      res.status(400).json({ success: false, message: validation.error || 'Invalid promo' });
      return;
    }
    
    // Calculate discount
    const discount = calculatePromoDiscount({
      promoType: validation.promo.type,
      promoValue: validation.promo.value,
      maxDiscount: validation.promo.maxDiscount,
      fare,
    });
    
    res.status(200).json({
      success: true,
      data: {
        promoId: validation.promo.id,
        code: validation.promo.code,
        ...discount,
      },
    });
  })
);

/**
 * GET /api/promo/active
 * Get active promos for the current user
 */
app.get(
  '/api/promo/active',
  [
    query('vehicleType').optional().isString(),
    query('city').optional().isString(),
  ],
  authenticate,
  asyncHandler(async (req: any, res) => {
    const userId = req.user.id;
    const vehicleType = req.query.vehicleType as string | undefined;
    const city = req.query.city as string | undefined;
    
    const promos = await getActivePromosForUser({ userId, vehicleType, city });
    
    res.status(200).json({ success: true, data: promos });
  })
);

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(PORT, () => logger.info(`Pricing service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start pricing-service', { error: err });
  process.exit(1);
});
