import express from 'express';
import cors from 'cors';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, optionalAuth, errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { calculateFare, getNearbyDrivers } from './pricingService';
import { prisma } from '@raahi/shared';

const logger = createLogger('pricing-service');
const app = express();
const PORT = process.env.PORT || 5005;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'pricing-service', timestamp: new Date().toISOString() });
});

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

app.get(
  '/api/pricing/nearby-drivers',
  [
    query('lat').isFloat({ min: -90, max: 90 }),
    query('lng').isFloat({ min: -180, max: 180 }),
    query('radius').optional().isFloat({ min: 1, max: 50 }),
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
    const drivers = await getNearbyDrivers(lat, lng, radius);
    res.status(200).json({ success: true, data: { drivers, count: drivers.length, radius } });
  })
);

app.get('/api/pricing/surge-areas', asyncHandler(async (req, res) => {
  const surgeAreas = await prisma.surgeArea.findMany({
    where: { isActive: true },
    select: { id: true, name: true, centerLatitude: true, centerLongitude: true, radius: true, multiplier: true },
  });
  res.status(200).json({ success: true, data: { surgeAreas, count: surgeAreas.length } });
}));

app.get('/api/pricing/rules', asyncHandler(async (req, res) => {
  const now = new Date();
  const rule = await prisma.pricingRule.findFirst({
    where: {
      isActive: true,
      validFrom: { lte: now },
      OR: [{ validTo: null }, { validTo: { gte: now } }],
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!rule) {
    res.status(200).json({
      success: true,
      data: {
        baseFare: parseFloat(process.env.BASE_FARE || '25'),
        perKmRate: parseFloat(process.env.PER_KM_RATE || '12'),
        perMinuteRate: parseFloat(process.env.PER_MINUTE_RATE || '2'),
        surgeMultiplier: 1.0,
        peakHourMultiplier: 1.0,
      },
    });
    return;
  }
  res.status(200).json({ success: true, data: rule });
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
