import express from 'express';
import cors from 'cors';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, authenticate, errorHandler, notFound, asyncHandler, setupSwagger } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import {
  calculateFare,
  calculateAllFares,
  finalizeFare,
  getNearbyDrivers,
  getPricingRules,
  getDriverQuestsSnapshot,
  updateDriverQuestProgress,
} from './pricingService';
import {
  validatePromo,
  calculatePromoDiscount,
  getActivePromosForUser,
  redeemPromo,
  invalidatePromoCache,
} from './promoService';
import { listZoneHealth, runMarketplaceGovernance, upsertMarketplacePolicy, getMarketplacePolicy } from './marketplacePolicy';
import { getAvailableServices } from './serviceCatalog';
import { IntercityRouteError, intercityResponsePayload } from './intercity';

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

/**
 * Accept EITHER a valid user JWT OR a valid internal API key.
 * Use on endpoints that are called both by clients (with JWT) and by
 * other services internally (with x-internal-api-key).
 */
function authenticateOrInternal(req: express.Request, res: express.Response, next: express.NextFunction) {
  const internalApiKey = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';
  const provided = req.headers['x-internal-api-key'] as string | undefined;
  if (provided && provided === internalApiKey) {
    return next();
  }
  // Fall through to JWT auth
  return authenticate(req, res, next);
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
    body('stops').optional().isArray(),
    body('stops.*.lat').isFloat({ min: -90, max: 90 }),
    body('stops.*.lng').isFloat({ min: -180, max: 180 }),
    body('stops.*.address').optional().isString(),
  ],
  authenticateOrInternal,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { pickupLat, pickupLng, dropLat, dropLng, vehicleType, scheduledTime, stops } = req.body;
    try {
      const pricing = await calculateFare({
        pickupLat,
        pickupLng,
        dropLat,
        dropLng,
        vehicleType,
        scheduledTime: scheduledTime ? new Date(scheduledTime) : undefined,
        stops,
      });
      res.status(200).json({ success: true, data: pricing });
    } catch (error: any) {
      // Intercity routes are a valid answer, not an error: the app shows the
      // Intercity (coming soon) product instead of city vehicles.
      if (error instanceof IntercityRouteError) {
        res.status(200).json({ success: true, data: intercityResponsePayload(error) });
        return;
      }
      throw error;
    }
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
    body('stops').optional().isArray(),
    body('stops.*.lat').isFloat({ min: -90, max: 90 }),
    body('stops.*.lng').isFloat({ min: -180, max: 180 }),
    body('stops.*.address').optional().isString(),
  ],
  authenticateOrInternal,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { pickupLat, pickupLng, dropLat, dropLng, scheduledTime, stops } = req.body;
    try {
      const allFares = await calculateAllFares(
        pickupLat,
        pickupLng,
        dropLat,
        dropLng,
        scheduledTime ? new Date(scheduledTime) : undefined,
        stops
      );
      res.status(200).json({ success: true, data: allFares });
    } catch (error: any) {
      if (error instanceof IntercityRouteError) {
        res.status(200).json({ success: true, data: intercityResponsePayload(error) });
        return;
      }
      throw error;
    }
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
  authenticateOrInternal,
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
  authenticateOrInternal,
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
 * @openapi
 * /api/pricing/driver-quests:
 *   get:
 *     tags: [Pricing]
 *     summary: Get daily quest progress for the authenticated driver
 *     responses:
 *       200:
 *         description: Driver quests fetched
 *       401:
 *         description: Unauthorized
 */
app.get(
  '/api/pricing/driver-quests',
  authenticate,
  asyncHandler(async (req: any, res) => {
    try {
      const snapshot = await getDriverQuestsSnapshot(req.user.id);
      res.status(200).json({ success: true, data: snapshot });
    } catch (error) {
      const message = (error as Error).message || 'Failed to fetch driver quests';
      if (message === 'Driver profile not found') {
        res.status(404).json({ success: false, message });
        return;
      }
      throw error;
    }
  })
);

/**
 * @openapi
 * /api/pricing/driver-quests/progress:
 *   post:
 *     tags: [Pricing]
 *     summary: Update quest progress hint (authoritative progress is ride-derived)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [questId]
 *             properties:
 *               questId:
 *                 type: string
 *               completedRides:
 *                 type: integer
 *                 minimum: 0
 *     responses:
 *       200:
 *         description: Quest progress recalculated
 *       400:
 *         description: Validation failed
 */
app.post(
  '/api/pricing/driver-quests/progress',
  authenticate,
  [
    body('questId').isString().notEmpty(),
    body('completedRides').optional().isInt({ min: 0 }),
  ],
  asyncHandler(async (req: any, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    try {
      const snapshot = await updateDriverQuestProgress(
        req.user.id,
        req.body.questId,
        req.body.completedRides
      );

      res.status(200).json({ success: true, data: snapshot });
    } catch (error) {
      const message = (error as Error).message || 'Failed to update quest progress';
      if (message === 'Driver profile not found') {
        res.status(404).json({ success: false, message });
        return;
      }
      throw error;
    }
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

/**
 * @openapi
 * /api/pricing/available-services:
 *   get:
 *     tags: [Pricing]
 *     summary: Rider-facing service catalog with per-city availability
 *     parameters:
 *       - in: query
 *         name: lat
 *         schema: { type: number }
 *       - in: query
 *         name: lng
 *         schema: { type: number }
 *       - in: query
 *         name: dropLat
 *         schema: { type: number }
 *       - in: query
 *         name: dropLng
 *         schema: { type: number }
 *       - in: query
 *         name: city
 *         schema: { type: string }
 *       - in: query
 *         name: includeDisabled
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: Service catalog for the resolved city
 */
app.get(
  '/api/pricing/available-services',
  [
    query('lat').optional().isFloat({ min: -90, max: 90 }),
    query('lng').optional().isFloat({ min: -180, max: 180 }),
    query('dropLat').optional().isFloat({ min: -90, max: 90 }),
    query('dropLng').optional().isFloat({ min: -180, max: 180 }),
    query('city').optional().isString(),
    query('includeDisabled').optional().isBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const lat = req.query.lat != null ? parseFloat(req.query.lat as string) : undefined;
    const lng = req.query.lng != null ? parseFloat(req.query.lng as string) : undefined;
    const dropLat = req.query.dropLat != null ? parseFloat(req.query.dropLat as string) : undefined;
    const dropLng = req.query.dropLng != null ? parseFloat(req.query.dropLng as string) : undefined;
    const city = req.query.city as string | undefined;
    const includeDisabled = req.query.includeDisabled === 'true';

    const data = await getAvailableServices({ lat, lng, dropLat, dropLng, city, includeDisabled });
    res.status(200).json({ success: true, data });
  }),
);

/**
 * Resolve whether Raahi currently operates at a lat/lng (active zone geofence).
 * Used by the rider app for first-install / city-switch welcome notifications.
 */
app.get(
  '/api/pricing/city-availability',
  [
    query('lat').isFloat({ min: -90, max: 90 }),
    query('lng').isFloat({ min: -180, max: 180 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);
    const { resolveZone, listZones, normalizeCity } = require('@raahi/shared');

    const resolvedCode = normalizeCity(await resolveZone(lat, lng));
    const zones = await listZones();
    const match = zones.find(
      (z: { code: string; isActive: boolean }) =>
        z.isActive && normalizeCity(z.code) === resolvedCode,
    );

    const rawName = (match?.name as string | undefined) || resolvedCode;
    // "Gurgaon (Gurugram, Haryana)" → "Gurgaon"
    const cityName = String(rawName).split('(')[0].trim() || resolvedCode;

    res.status(200).json({
      success: true,
      data: {
        available: Boolean(match),
        cityCode: match?.code ?? resolvedCode,
        cityName,
      },
    });
  }),
);

// ============================================================
// Marketplace policy controls (v2 scalability operations)
// ============================================================

app.get(
  '/api/pricing/marketplace/policy',
  [query('cityCode').isString().notEmpty()],
  authenticate,
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

/**
 * POST /api/promo/redeem  (internal — called by ride-service at booking time)
 * Validates the code, computes the discount, and (if rideId given) records a
 * redemption so per-user / global limits take effect. Idempotent per rideId.
 * Omit rideId for a dry-run (validate + price only, no usage recorded).
 */
app.post(
  '/api/promo/redeem',
  authenticateInternal,
  [
    body('code').isString().notEmpty().trim(),
    body('userId').isString().notEmpty(),
    body('rideId').optional().isString().notEmpty(),
    body('fare').optional().isFloat({ min: 0 }),
    body('vehicleType').optional().isString(),
    body('city').optional().isString(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const { code, userId, rideId, fare, vehicleType, city } = req.body;
    const result = await redeemPromo({ code, userId, rideId, fare, vehicleType, city });

    if (!result.valid || !result.promo) {
      res.status(400).json({ success: false, message: result.error || 'Invalid promo' });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        promoId: result.promo.id,
        code: result.promo.code,
        type: result.promo.type,
        recorded: result.recorded,
        discount: result.discount,
      },
    });
  })
);

// ============================================================
// Promo Management (admin — internal API key required)
// ============================================================

const PROMO_TYPES = ['PERCENT', 'FLAT', 'CASHBACK'];

/**
 * GET /api/promo/admin — list ALL promos (including inactive/expired) with usage totals.
 */
app.get(
  '/api/promo/admin',
  authenticateInternal,
  asyncHandler(async (_req, res) => {
    const { prisma } = require('@raahi/shared');
    const promos = await prisma.promo.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { usages: true } } },
    });
    res.status(200).json({ success: true, data: promos });
  })
);

/**
 * POST /api/promo/admin — create or update a promo (upsert by code).
 */
app.post(
  '/api/promo/admin',
  authenticateInternal,
  [
    body('code').isString().notEmpty().trim(),
    body('type').isString().custom((v) => PROMO_TYPES.includes(String(v).toUpperCase())),
    body('value').isFloat({ min: 0 }),
    body('maxDiscount').optional({ nullable: true }).isFloat({ min: 0 }),
    body('minFare').optional({ nullable: true }).isFloat({ min: 0 }),
    body('usageLimit').optional({ nullable: true }).isInt({ min: 1 }),
    body('perUserLimit').optional().isInt({ min: 1 }),
    body('validFrom').optional().isISO8601(),
    body('validTo').optional({ nullable: true }).isISO8601(),
    body('vehicleTypes').optional().isArray(),
    body('cities').optional().isArray(),
    body('isFirstRideOnly').optional().isBoolean(),
    body('isActive').optional().isBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const { prisma } = require('@raahi/shared');
    const b = req.body;
    const code = String(b.code).toUpperCase();

    const data = {
      type: String(b.type).toUpperCase(),
      value: b.value,
      maxDiscount: b.maxDiscount ?? null,
      minFare: b.minFare ?? null,
      usageLimit: b.usageLimit ?? null,
      perUserLimit: b.perUserLimit ?? 1,
      validFrom: b.validFrom ? new Date(b.validFrom) : new Date(),
      validTo: b.validTo ? new Date(b.validTo) : null,
      vehicleTypes: Array.isArray(b.vehicleTypes) ? b.vehicleTypes.map((v: string) => v.toLowerCase()) : [],
      cities: Array.isArray(b.cities) ? b.cities.map((c: string) => c.toLowerCase()) : [],
      isFirstRideOnly: b.isFirstRideOnly ?? false,
      isActive: b.isActive ?? true,
    };

    const promo = await prisma.promo.upsert({
      where: { code },
      update: data,
      create: { code, ...data },
    });

    invalidatePromoCache();
    res.status(200).json({ success: true, message: 'Promo saved', data: promo });
  })
);

/**
 * PATCH /api/promo/admin/:id — partial update (e.g. toggle isActive, change value).
 */
app.patch(
  '/api/promo/admin/:id',
  authenticateInternal,
  [
    body('type').optional().isString().custom((v) => PROMO_TYPES.includes(String(v).toUpperCase())),
    body('value').optional().isFloat({ min: 0 }),
    body('maxDiscount').optional({ nullable: true }).isFloat({ min: 0 }),
    body('minFare').optional({ nullable: true }).isFloat({ min: 0 }),
    body('usageLimit').optional({ nullable: true }).isInt({ min: 1 }),
    body('perUserLimit').optional().isInt({ min: 1 }),
    body('validFrom').optional().isISO8601(),
    body('validTo').optional({ nullable: true }).isISO8601(),
    body('vehicleTypes').optional().isArray(),
    body('cities').optional().isArray(),
    body('isFirstRideOnly').optional().isBoolean(),
    body('isActive').optional().isBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const { prisma } = require('@raahi/shared');
    const b = req.body;
    const data: Record<string, any> = {};
    if (b.type !== undefined) data.type = String(b.type).toUpperCase();
    if (b.value !== undefined) data.value = b.value;
    if (b.maxDiscount !== undefined) data.maxDiscount = b.maxDiscount;
    if (b.minFare !== undefined) data.minFare = b.minFare;
    if (b.usageLimit !== undefined) data.usageLimit = b.usageLimit;
    if (b.perUserLimit !== undefined) data.perUserLimit = b.perUserLimit;
    if (b.validFrom !== undefined) data.validFrom = new Date(b.validFrom);
    if (b.validTo !== undefined) data.validTo = b.validTo ? new Date(b.validTo) : null;
    if (b.vehicleTypes !== undefined) data.vehicleTypes = (b.vehicleTypes || []).map((v: string) => v.toLowerCase());
    if (b.cities !== undefined) data.cities = (b.cities || []).map((c: string) => c.toLowerCase());
    if (b.isFirstRideOnly !== undefined) data.isFirstRideOnly = b.isFirstRideOnly;
    if (b.isActive !== undefined) data.isActive = b.isActive;

    try {
      const promo = await prisma.promo.update({ where: { id: req.params.id }, data });
      invalidatePromoCache();
      res.status(200).json({ success: true, message: 'Promo updated', data: promo });
    } catch (err: any) {
      if (err?.code === 'P2025') {
        res.status(404).json({ success: false, message: 'Promo not found' });
        return;
      }
      throw err;
    }
  })
);

/**
 * DELETE /api/promo/admin/:id — remove a promo (cascades its usage rows).
 */
app.delete(
  '/api/promo/admin/:id',
  authenticateInternal,
  asyncHandler(async (req, res) => {
    const { prisma } = require('@raahi/shared');
    try {
      await prisma.promo.delete({ where: { id: req.params.id } });
      invalidatePromoCache();
      res.status(200).json({ success: true, message: 'Promo deleted' });
    } catch (err: any) {
      if (err?.code === 'P2025') {
        res.status(404).json({ success: false, message: 'Promo not found' });
        return;
      }
      throw err;
    }
  })
);

// ============================================================
// Cross-Zone Rules Management
// ============================================================

/**
 * @openapi
 * /api/pricing/cross-zone-rules:
 *   get:
 *     tags: [Pricing Rules]
 *     summary: Get all cross-zone vehicle restriction rules
 *     responses:
 *       200:
 *         description: List of rules
 */
app.get(
  '/api/pricing/cross-zone-rules',
  authenticateOrInternal,
  asyncHandler(async (_req, res) => {
    const { prisma } = require('@raahi/shared');
    const rules = await prisma.crossZoneRule.findMany({
      orderBy: [
        { origin: 'asc' },
        { destination: 'asc' },
      ],
    });
    res.status(200).json({ success: true, data: rules });
  })
);

/**
 * @openapi
 * /api/pricing/cross-zone-rules:
 *   post:
 *     tags: [Pricing Rules]
 *     summary: Create or update a cross-zone vehicle restriction rule
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [origin, destination, vehicleType, isAllowed]
 *             properties:
 *               origin:
 *                 type: string
 *                 example: "delhi"
 *               destination:
 *                 type: string
 *                 example: "noida"
 *               vehicleType:
 *                 type: string
 *                 example: "auto"
 *               isAllowed:
 *                 type: boolean
 *                 example: false
 *               reason:
 *                 type: string
 *                 example: "Auto-rickshaws do not have a permit to cross the Delhi-UP state border."
 *     responses:
 *       200:
 *         description: Rule updated successfully
 */
app.post(
  '/api/pricing/cross-zone-rules',
  authenticateInternal,
  [
    body('origin').isString().notEmpty().toLowerCase().trim(),
    body('destination').isString().notEmpty().toLowerCase().trim(),
    body('vehicleType').isString().notEmpty().toLowerCase().trim(),
    body('isAllowed').isBoolean(),
    body('reason').optional().isString(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }

    const { origin, destination, vehicleType, isAllowed, reason } = req.body;
    const { prisma, invalidateCrossZoneCache } = require('@raahi/shared');

    const rule = await prisma.crossZoneRule.upsert({
      where: {
        origin_destination_vehicleType: {
          origin,
          destination,
          vehicleType,
        },
      },
      update: {
        isAllowed,
        reason: reason || null,
      },
      create: {
        origin,
        destination,
        vehicleType,
        isAllowed,
        reason: reason || null,
      },
    });

    invalidateCrossZoneCache();

    res.status(200).json({ success: true, message: 'Cross-zone rule saved successfully', data: rule });
  })
);

/**
 * @openapi
 * /api/pricing/cross-zone-rules/{id}:
 *   delete:
 *     tags: [Pricing Rules]
 *     summary: Delete a cross-zone vehicle restriction rule
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Rule deleted successfully
 */
app.delete(
  '/api/pricing/cross-zone-rules/:id',
  authenticateInternal,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { prisma, invalidateCrossZoneCache } = require('@raahi/shared');

    try {
      await prisma.crossZoneRule.delete({
        where: { id },
      });
    } catch (error: any) {
      if (error?.code === 'P2025') {
        res.status(404).json({ success: false, message: 'Cross-zone rule not found' });
        return;
      }
      throw error;
    }

    invalidateCrossZoneCache();

    res.status(200).json({ success: true, message: 'Cross-zone rule deleted successfully' });
  })
);

// ============================================================
// Zone geofence management (H3-based operational zones)
// ============================================================

/**
 * @openapi
 * /api/pricing/zones:
 *   get:
 *     tags: [Pricing Rules]
 *     summary: List operational zones and their H3 cell counts
 *     responses:
 *       200:
 *         description: List of zones
 */
app.get(
  '/api/pricing/zones',
  authenticateOrInternal,
  asyncHandler(async (_req, res) => {
    const { listZones } = require('@raahi/shared');
    const zones = await listZones();
    res.status(200).json({ success: true, data: zones });
  })
);

/**
 * @openapi
 * /api/pricing/zones:
 *   post:
 *     tags: [Pricing Rules]
 *     summary: Create or replace a zone geofence (from GeoJSON polygon, circle, or H3 cells)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, name]
 *             properties:
 *               code: { type: string, example: "noida" }
 *               name: { type: string, example: "Noida" }
 *               type: { type: string, example: "city" }
 *               polygon:
 *                 type: array
 *                 description: GeoJSON polygon rings ([lng,lat]); first ring outer, rest holes
 *               circle:
 *                 type: object
 *                 properties:
 *                   lat: { type: number }
 *                   lng: { type: number }
 *                   radiusKm: { type: number }
 *               h3Cells:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Zone saved
 */
app.post(
  '/api/pricing/zones',
  authenticateInternal,
  [
    body('code').isString().notEmpty().trim(),
    body('name').isString().notEmpty().trim(),
    body('type').optional().isString(),
    body('polygon').optional().isArray(),
    body('circle').optional().isObject(),
    body('circle.lat').optional().isFloat({ min: -90, max: 90 }),
    body('circle.lng').optional().isFloat({ min: -180, max: 180 }),
    body('circle.radiusKm').optional().isFloat({ min: 0.1, max: 200 }),
    body('h3Cells').optional().isArray(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { upsertZoneGeofence } = require('@raahi/shared');
    try {
      const result = await upsertZoneGeofence({
        code: req.body.code,
        name: req.body.name,
        type: req.body.type,
        polygon: req.body.polygon,
        circle: req.body.circle,
        h3Cells: req.body.h3Cells,
      });
      res.status(200).json({ success: true, message: 'Zone saved successfully', data: result });
    } catch (error) {
      res.status(400).json({ success: false, message: (error as Error).message });
    }
  })
);

/**
 * @openapi
 * /api/pricing/zones/{code}:
 *   delete:
 *     tags: [Pricing Rules]
 *     summary: Delete a zone and its geofence cells
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Zone deleted
 */
app.delete(
  '/api/pricing/zones/:code',
  authenticateInternal,
  asyncHandler(async (req, res) => {
    const { deleteZone } = require('@raahi/shared');
    try {
      await deleteZone(req.params.code);
    } catch (error: any) {
      if (error?.code === 'P2025') {
        res.status(404).json({ success: false, message: 'Zone not found' });
        return;
      }
      throw error;
    }
    res.status(200).json({ success: true, message: 'Zone deleted successfully' });
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
