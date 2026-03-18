import express from 'express';
import cors from 'cors';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, optionalAuth, authenticate, errorHandler, notFound, asyncHandler, setupSwagger } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { calculateFare, calculateAllFares, finalizeFare, getNearbyDrivers, getPricingRules } from './pricingService';
import { validatePromo, calculatePromoDiscount, getActivePromosForUser } from './promoService';
import { listZoneHealth, runMarketplaceGovernance, upsertMarketplacePolicy, getMarketplacePolicy } from './marketplacePolicy';

const logger = createLogger('pricing-service');
const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json());

function authenticateInternal(req: express.Request, res: express.Response, next: express.NextFunction) {
  const internalApiKey = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';
  const provided = req.headers['x-internal-api-key'] as string | undefined;
  if (!provided || provided !== internalApiKey) {
    res.status(401).json({ success: false, message: 'Unauthorized internal API request' });
    return;
  }
  next();
}

// Setup Swagger documentation
setupSwagger(app, {
  title: 'Pricing Service API',
  version: '1.0.0',
  description: 'Raahi Pricing Service - Fare calculation, nearby drivers, and promo codes',
  port: Number(PORT),
  basePath: '/api/pricing',
  apis: [__filename],
});

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Health check endpoint
 *     responses:
 *       200:
 *         description: Service is healthy
 */
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'pricing-service', timestamp: new Date().toISOString() });
});

/**
 * @openapi
 * /api/pricing/calculate:
 *   post:
 *     tags: [Pricing]
 *     summary: Calculate fare for a ride
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pickupLat, pickupLng, dropLat, dropLng]
 *             properties:
 *               pickupLat:
 *                 type: number
 *               pickupLng:
 *                 type: number
 *               dropLat:
 *                 type: number
 *               dropLng:
 *                 type: number
 *               vehicleType:
 *                 type: string
 *               scheduledTime:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Fare estimate
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/FareBreakdown'
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
 * @openapi
 * /api/pricing/calculate-all:
 *   post:
 *     tags: [Pricing]
 *     summary: Calculate fares for all vehicle types
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pickupLat, pickupLng, dropLat, dropLng]
 *             properties:
 *               pickupLat:
 *                 type: number
 *               pickupLng:
 *                 type: number
 *               dropLat:
 *                 type: number
 *               dropLng:
 *                 type: number
 *               scheduledTime:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Fare estimates for all vehicle types
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
 * @openapi
 * /api/pricing/finalize:
 *   post:
 *     tags: [Pricing]
 *     summary: Finalize fare after ride completion
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rideId, dynamicFare]
 *             properties:
 *               rideId:
 *                 type: string
 *               dynamicFare:
 *                 type: number
 *               tolls:
 *                 type: number
 *               waitingMinutes:
 *                 type: number
 *               parkingFees:
 *                 type: number
 *               extraStopsCount:
 *                 type: integer
 *               discountPercent:
 *                 type: number
 *     responses:
 *       200:
 *         description: Final fare calculated
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
 * @openapi
 * /api/pricing/nearby-drivers:
 *   get:
 *     tags: [Pricing]
 *     summary: Get nearby available drivers
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
 *           type: number
 *           default: 5
 *       - in: query
 *         name: vehicleType
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of nearby drivers
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
// Marketplace policy controls (v2 scalability operations)
// ============================================================

app.get(
  '/api/pricing/marketplace/policy',
  [query('cityCode').isString().notEmpty()],
  optionalAuth,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const cityCode = (req.query.cityCode as string).toLowerCase().trim();
    const policy = await getMarketplacePolicy(cityCode);
    res.status(200).json({ success: true, data: policy });
  })
);

app.put(
  '/api/pricing/marketplace/policy',
  authenticateInternal,
  [
    body('cityCode').isString().notEmpty(),
    body('marketplaceMode').optional().isIn(['launch', 'scale']),
    body('launchSubsidyPct').optional().isFloat({ min: 0, max: 1 }),
    body('launchSubsidyCap').optional().isFloat({ min: 0 }),
    body('burnCap').optional().isFloat({ min: 0, max: 1 }),
    body('contributionFloor').optional().isFloat({ max: 0 }),
    body('etaTargetMin').optional().isFloat({ min: 1 }),
    body('supplyThreshold').optional().isFloat({ min: 0 }),
    body('isActive').optional().isBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const updated = await upsertMarketplacePolicy({
      cityCode: (req.body.cityCode as string).toLowerCase().trim(),
      marketplaceMode: req.body.marketplaceMode,
      launchSubsidyPct: req.body.launchSubsidyPct,
      launchSubsidyCap: req.body.launchSubsidyCap,
      burnCap: req.body.burnCap,
      contributionFloor: req.body.contributionFloor,
      etaTargetMin: req.body.etaTargetMin,
      supplyThreshold: req.body.supplyThreshold,
      isActive: req.body.isActive,
    });
    res.status(200).json({ success: true, data: updated });
  })
);

app.get(
  '/api/pricing/marketplace/zone-health',
  [query('cityCode').isString().notEmpty(), query('limit').optional().isInt({ min: 1, max: 500 })],
  authenticateInternal,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const cityCode = (req.query.cityCode as string).toLowerCase().trim();
    const limit = parseInt((req.query.limit as string) || '50', 10);
    const rows = await listZoneHealth(cityCode, limit);
    res.status(200).json({ success: true, data: { cityCode, count: rows.length, rows } });
  })
);

app.post(
  '/api/pricing/marketplace/governance/run',
  authenticateInternal,
  [body('cityCode').optional().isString()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const cityCode = req.body.cityCode ? (req.body.cityCode as string).toLowerCase().trim() : undefined;
    const result = await runMarketplaceGovernance(cityCode);
    res.status(200).json({ success: true, data: result });
  })
);

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

  // Periodic governance loop for burn control + mode lifecycle.
  const governanceMs = Number(process.env.MARKETPLACE_GOVERNANCE_INTERVAL_MS ?? 15 * 60 * 1000);
  setInterval(() => {
    runMarketplaceGovernance()
      .then((result) => {
        logger.info('[MARKETPLACE] Governance cycle completed', result);
      })
      .catch((error) => {
        logger.warn('[MARKETPLACE] Governance cycle failed', { error: (error as Error).message });
      });
  }, governanceMs);
};

start().catch((err) => {
  logger.error('Failed to start pricing-service', { error: err });
  process.exit(1);
});
