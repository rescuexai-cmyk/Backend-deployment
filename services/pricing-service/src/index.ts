import express from 'express';
import cors from 'cors';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, optionalAuth, errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { calculateFare, calculateAllFares, getNearbyDrivers, getPricingRules } from './pricingService';

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
 * Calculate fares for ALL vehicle types (cab, auto, bike) in one call.
 * Useful for the ride-booking screen to show all options at once.
 */
app.post(
  '/api/pricing/calculate-all',
  [
    body('pickupLat').isFloat({ min: -90, max: 90 }),
    body('pickupLng').isFloat({ min: -180, max: 180 }),
    body('dropLat').isFloat({ min: -90, max: 90 }),
    body('dropLng').isFloat({ min: -180, max: 180 }),
  ],
  optionalAuth,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    const { pickupLat, pickupLng, dropLat, dropLng } = req.body;
    const allFares = await calculateAllFares(pickupLat, pickupLng, dropLat, dropLng);
    res.status(200).json({ success: true, data: allFares });
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
