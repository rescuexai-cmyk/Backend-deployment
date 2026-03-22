import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, authenticate, authenticateDriver, AuthRequest, setupSwagger } from '@raahi/shared';
import { errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger, latLngToH3 } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import { canDriverStartRides, DRIVER_NOT_VERIFIED_ERROR, REQUIRED_DOCUMENTS, checkRequiredDocuments } from '@raahi/shared';
import { OnboardingStatus, PenaltyStatus, DocumentType } from '@prisma/client';
import * as DigiLocker from './digilocker';
import { createUploadMiddleware, getDocumentUrl, getStorageConfig, isSpacesConfigured, deleteOldDocument } from './storage';
import { addVerificationJob, isQueueAvailable, closeQueues } from './queues';
import { startVerificationWorker, stopVerificationWorker } from './documentVerificationWorker';
import { isVisionConfigured } from './visionService';
import * as PayoutService from './payoutService';

// Helper function to get platform config with error handling
async function getPlatformConfig(key: string, defaultValue: string): Promise<string> {
  try {
    const config = await prisma.platformConfig.findUnique({ where: { key } });
    return config?.value ?? defaultValue;
  } catch (error) {
    logger.warn(`[CONFIG] Failed to fetch platform config for key '${key}', using default: ${defaultValue}`, { error });
    return defaultValue;
  }
}

// Constants for validation
const MAX_PAGINATION_LIMIT = 100;
const DEFAULT_PAGINATION_LIMIT = 20;

// Helper to sanitize pagination params
function sanitizePagination(page?: string | number, limit?: string | number): { page: number; limit: number } {
  const parsedPage = typeof page === 'string' ? parseInt(page, 10) : (page || 1);
  const parsedLimit = typeof limit === 'string' ? parseInt(limit, 10) : (limit || DEFAULT_PAGINATION_LIMIT);
  
  return {
    page: Math.max(1, isNaN(parsedPage) ? 1 : parsedPage),
    limit: Math.min(MAX_PAGINATION_LIMIT, Math.max(1, isNaN(parsedLimit) ? DEFAULT_PAGINATION_LIMIT : parsedLimit)),
  };
}

// Helper to calculate hours from seconds
function secondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 10) / 10; // Round to 1 decimal
}

const logger = createLogger('driver-service');
const app = express();
const PORT = process.env.PORT || 5003;

// Local uploads directory (for fallback or serving existing local files)
const uploadsBaseDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsBaseDir)) {
  fs.mkdirSync(uploadsBaseDir, { recursive: true });
}

// Create folders for each document type
for (const docType of REQUIRED_DOCUMENTS) {
  const docDir = path.join(uploadsBaseDir, docType);
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }
}

// Document upload middleware (uses DO Spaces if configured, else local disk)
const upload = createUploadMiddleware();

// Log storage configuration on startup
const storageConfig = getStorageConfig();
logger.info(`[STORAGE] Using ${storageConfig.type} storage${storageConfig.bucket ? ` (bucket: ${storageConfig.bucket})` : ''}`);

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadsBaseDir));

// Setup Swagger documentation
setupSwagger(app, {
  title: 'Driver Service API',
  version: '1.0.0',
  description: 'Raahi Driver Service - Driver onboarding, documents, earnings, payouts, and profile management',
  port: Number(PORT),
  basePath: '/api/driver',
  apis: [__filename, path.join(__dirname, './swagger-definitions.ts'), path.join(__dirname, './swagger-definitions.js')],
});

/**
 * @openapi
 * tags:
 *   - name: Health
 *     description: Service health check
 *   - name: Driver Profile
 *     description: Driver profile and status management
 *   - name: Subscription
 *     description: Daily platform fee subscription (₹39/day)
 *   - name: Penalties
 *     description: Driver penalty management
 *   - name: Earnings
 *     description: Driver earnings and transactions
 *   - name: Payout Accounts
 *     description: Bank account and UPI management for payouts
 *   - name: Wallet
 *     description: Wallet balance and withdrawals
 *   - name: Trips
 *     description: Driver trip history
 *   - name: Support
 *     description: Driver support tickets
 *   - name: Settings
 *     description: Driver settings and preferences
 *   - name: Onboarding
 *     description: Driver onboarding flow
 *   - name: Documents
 *     description: Document upload and verification
 *   - name: DigiLocker
 *     description: DigiLocker integration for KYC
 *   - name: Aadhaar
 *     description: Aadhaar OTP verification
 */

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Health check endpoint
 *     responses:
 *       200:
 *         description: Service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: OK
 *                 service:
 *                   type: string
 *                   example: driver-service
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *                 storage:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       example: digitalocean-spaces
 *                     configured:
 *                       type: boolean
 *                     bucket:
 *                       type: string
 *                     endpoint:
 *                       type: string
 */
app.get('/health', (req, res) => {
  const storage = getStorageConfig();
  res.json({ 
    status: 'OK', 
    service: 'driver-service', 
    timestamp: new Date().toISOString(),
    storage: {
      type: storage.type,
      configured: storage.type === 'digitalocean-spaces',
      bucket: storage.bucket,
      endpoint: storage.endpoint,
    },
  });
});

// Driver profile & status

/**
 * @openapi
 * /api/driver/profile:
 *   get:
 *     tags: [Driver Profile]
 *     summary: Get driver profile
 *     description: Returns complete driver profile including earnings, documents status, and vehicle info
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Driver profile retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/DriverProfile'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Driver not found
 */
app.get('/api/driver/profile', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - 7);
  const monthStart = new Date(today);
  monthStart.setMonth(today.getMonth() - 1);

  const driver = await prisma.driver.findFirst({
    where: { userId: req.user?.id },
    include: {
      user: true,
      documents: true,
      earnings: { orderBy: { date: 'desc' } },
    },
  });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }

  // Calculate real earnings for each period
  const todayEarnings = driver.earnings.filter((e) => e.date >= today).reduce((s, e) => s + e.netAmount, 0);
  const weekEarnings = driver.earnings.filter((e) => e.date >= weekStart).reduce((s, e) => s + e.netAmount, 0);
  const monthEarnings = driver.earnings.filter((e) => e.date >= monthStart).reduce((s, e) => s + e.netAmount, 0);

  const allDocsVerified = driver.documents.length > 0 && driver.documents.every((d) => d.isVerified);
  res.json({
    success: true,
    data: {
      driver_id: driver.id,
      email: driver.user.email,
      name: `${driver.user.firstName} ${driver.user.lastName || ''}`.trim(),
      phone: driver.user.phone,
      license_number: driver.licenseNumber,
      vehicle_info: { make: driver.vehicleModel?.split(' ')[0] || 'Unknown', model: driver.vehicleModel, year: driver.vehicleYear, license_plate: driver.vehicleNumber, color: driver.vehicleColor },
      documents: { license_verified: driver.documents.some((d) => d.documentType === 'LICENSE' && d.isVerified), insurance_verified: driver.documents.some((d) => d.documentType === 'INSURANCE' && d.isVerified), vehicle_registration_verified: driver.documents.some((d) => d.documentType === 'RC' && d.isVerified), all_verified: allDocsVerified, pending_count: driver.documents.filter((d) => !d.isVerified).length },
      onboarding: { status: driver.onboardingStatus, is_verified: driver.isVerified, documents_submitted: driver.documentsSubmittedAt != null, documents_verified: allDocsVerified, can_start_rides: canDriverStartRides(driver), verification_notes: driver.verificationNotes },
      status: driver.isActive ? 'active' : 'inactive',
      rating: driver.rating,
      rating_count: driver.ratingCount,
      total_trips: driver.totalRides,
      earnings: { today: todayEarnings, week: weekEarnings, month: monthEarnings, total: driver.totalEarnings },
      hours_online: secondsToHours(driver.totalOnlineSeconds),
      is_online: driver.isOnline,
      current_location: { latitude: driver.currentLatitude ?? null, longitude: driver.currentLongitude ?? null },
      notifications_enabled: driver.notificationsEnabled,
    },
  });
}));

const PENALTY_STOP_RIDING_AMOUNT = parseFloat(process.env.PENALTY_STOP_RIDING_AMOUNT || '10');

/**
 * @openapi
 * /api/driver/status:
 *   patch:
 *     tags: [Driver Profile]
 *     summary: Update driver online status
 *     description: Toggle driver online/offline status. May charge penalty when going offline.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [online]
 *             properties:
 *               online:
 *                 type: boolean
 *               location:
 *                 type: object
 *                 properties:
 *                   latitude:
 *                     type: number
 *                   longitude:
 *                     type: number
 *     responses:
 *       200:
 *         description: Status updated
 *       403:
 *         description: Driver not verified or has unpaid penalties
 *       404:
 *         description: Driver not found
 */
app.patch('/api/driver/status', authenticateDriver, [body('online').isBoolean(), body('location.latitude').optional().isFloat(), body('location.longitude').optional().isFloat()], asyncHandler(async (req: AuthRequest, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    return;
  }
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }
  
  const previousOnlineStatus = driver.isOnline;
  const newOnlineStatus = req.body.online;
  const statusChangeTimestamp = new Date();
  
  // CRITICAL: When driver tries to go ONLINE, enforce verification
  if (newOnlineStatus) {
    if (!canDriverStartRides(driver)) {
      logger.info(`[DRIVER_STATUS] Blocked go-online: driver ${driver.id} not verified (isActive=${driver.isActive}, isVerified=${driver.isVerified}, onboardingStatus=${driver.onboardingStatus})`);
      res.status(403).json({
        success: false,
        ...DRIVER_NOT_VERIFIED_ERROR,
        verificationState: {
          isActive: driver.isActive,
          isVerified: driver.isVerified,
          onboardingStatus: driver.onboardingStatus,
        },
      });
      return;
    }
  }
  
  // When driver tries to go ONLINE: block if they have unpaid "Stop Riding" penalty
  if (newOnlineStatus) {
    const unpaidPenalties = await prisma.driverPenalty.findMany({
      where: { driverId: driver.id, status: PenaltyStatus.PENDING },
      orderBy: { createdAt: 'asc' },
    });
    if (unpaidPenalties.length > 0) {
      const totalDue = unpaidPenalties.reduce((sum, p) => sum + p.amount, 0);
      logger.info(`[DRIVER_STATUS] Blocked go-online: driver ${driver.id} has ${unpaidPenalties.length} unpaid penalty(ies), ₹${totalDue} due`);
      res.status(403).json({
        success: false,
        message: `Pay penalty of ₹${totalDue} to start riding again. You were charged for stopping mid-day.`,
        code: 'PENALTY_UNPAID',
        penaltyDue: totalDue,
        unpaidCount: unpaidPenalties.length,
      });
      return;
    }
  }
  
  // Track online time: when going offline, calculate session duration
  let additionalOnlineSeconds = 0;
  if (previousOnlineStatus && !newOnlineStatus && driver.lastOnlineAt) {
    additionalOnlineSeconds = Math.floor((statusChangeTimestamp.getTime() - driver.lastOnlineAt.getTime()) / 1000);
    logger.info(`[DRIVER_STATUS] Session duration: ${additionalOnlineSeconds} seconds (${secondsToHours(additionalOnlineSeconds)} hours)`);
  }
  
  // When driver goes OFFLINE (Stop Riding): charge ₹10 penalty
  if (previousOnlineStatus && !newOnlineStatus) {
    await prisma.driverPenalty.create({
      data: {
        driverId: driver.id,
        amount: PENALTY_STOP_RIDING_AMOUNT,
        reason: 'STOP_RIDING',
        status: PenaltyStatus.PENDING,
      },
    });
    logger.info(`[DRIVER_STATUS] Penalty created: driver ${driver.id}, ₹${PENALTY_STOP_RIDING_AMOUNT} (Stop Riding)`);
  }
  
  // Compute H3 index if location is provided
  const newLat = req.body.location?.latitude ?? driver.currentLatitude;
  const newLng = req.body.location?.longitude ?? driver.currentLongitude;
  const h3Index = (newLat && newLng) ? latLngToH3(newLat, newLng) : driver.h3Index;
  
  const updated = await prisma.driver.update({
    where: { id: driver.id },
    data: {
      isOnline: newOnlineStatus,
      lastActiveAt: statusChangeTimestamp,
      lastOnlineAt: newOnlineStatus ? statusChangeTimestamp : driver.lastOnlineAt, // Set when going online
      totalOnlineSeconds: { increment: additionalOnlineSeconds }, // Add session time when going offline
      currentLatitude: newLat,
      currentLongitude: newLng,
      h3Index,  // Store H3 index for geospatial matching
    },
  });
  
  // CRITICAL: Log status change with timestamp for debugging
  logger.info(`[DRIVER_STATUS] ========== STATUS CHANGE ==========`);
  logger.info(`[DRIVER_STATUS] Driver ID: ${driver.id}`);
  logger.info(`[DRIVER_STATUS] User ID: ${req.user!.id}`);
  logger.info(`[DRIVER_STATUS] Previous status: ${previousOnlineStatus ? 'ONLINE' : 'OFFLINE'}`);
  logger.info(`[DRIVER_STATUS] New status: ${newOnlineStatus ? 'ONLINE' : 'OFFLINE'}`);
  logger.info(`[DRIVER_STATUS] Timestamp: ${statusChangeTimestamp.toISOString()}`);
  logger.info(`[DRIVER_STATUS] Location: (${updated.currentLatitude}, ${updated.currentLongitude})`);
  logger.info(`[DRIVER_STATUS] H3 Index: ${updated.h3Index}`);
  logger.info(`[DRIVER_STATUS] DB isOnline now: ${updated.isOnline}`);
  logger.info(`[DRIVER_STATUS] Total online time: ${secondsToHours(updated.totalOnlineSeconds)} hours`);
  
  // Verify the update was persisted
  const verifyDriver = await prisma.driver.findUnique({ where: { id: driver.id }, select: { isOnline: true } });
  if (verifyDriver?.isOnline !== newOnlineStatus) {
    logger.error(`[DRIVER_STATUS] 🚨 P0 ERROR: DB update verification FAILED! Expected ${newOnlineStatus}, got ${verifyDriver?.isOnline}`);
  } else {
    logger.info(`[DRIVER_STATUS] ✅ DB update verified successfully`);
  }
  
  logger.info(`[DRIVER_STATUS] ========== STATUS CHANGE COMPLETE ==========`);
  
  res.json({
    success: true,
    message: `Driver is now ${updated.isOnline ? 'online' : 'offline'}`,
    data: { 
      driver_id: updated.id, 
      online: updated.isOnline, 
      last_seen: updated.lastActiveAt?.toISOString(), 
      location: { latitude: updated.currentLatitude ?? null, longitude: updated.currentLongitude ?? null },
      h3_index: updated.h3Index,  // Include H3 index in response
      // Include verification info for client
      status_verified: verifyDriver?.isOnline === newOnlineStatus,
      status_change_timestamp: statusChangeTimestamp.toISOString(),
      total_hours_online: secondsToHours(updated.totalOnlineSeconds),
    },
  });
}));

/**
 * @openapi
 * /api/driver/penalties:
 *   get:
 *     tags: [Penalties]
 *     summary: List driver penalties
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [PENDING, PAID]
 *     responses:
 *       200:
 *         description: Penalties retrieved
 */
app.get('/api/driver/penalties', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }
  const statusFilter = req.query.status as string | undefined;
  const where: any = { driverId: driver.id };
  if (statusFilter === 'PENDING' || statusFilter === 'PAID') {
    where.status = statusFilter;
  }
  const penalties = await prisma.driverPenalty.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });
  const unpaidTotal = penalties.filter((p) => p.status === PenaltyStatus.PENDING).reduce((s, p) => s + p.amount, 0);
  res.json({
    success: true,
    data: {
      penalties: penalties.map((p) => ({
        id: p.id,
        amount: p.amount,
        reason: p.reason,
        status: p.status,
        createdAt: p.createdAt.toISOString(),
        paidAt: p.paidAt?.toISOString() ?? null,
      })),
      unpaidTotal,
      canGoOnline: unpaidTotal === 0,
    },
  });
}));

/**
 * @openapi
 * /api/driver/penalties/pay:
 *   post:
 *     tags: [Penalties]
 *     summary: Pay all pending penalties
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Penalties paid
 */
app.post('/api/driver/penalties/pay', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }
  const unpaid = await prisma.driverPenalty.findMany({
    where: { driverId: driver.id, status: PenaltyStatus.PENDING },
    orderBy: { createdAt: 'asc' },
  });
  if (unpaid.length === 0) {
    res.json({
      success: true,
      message: 'No pending penalties',
      data: { paidCount: 0, totalPaid: 0 },
    });
    return;
  }
  const now = new Date();
  await prisma.driverPenalty.updateMany({
    where: { driverId: driver.id, status: PenaltyStatus.PENDING },
    data: { status: PenaltyStatus.PAID, paidAt: now },
  });
  const totalPaid = unpaid.reduce((s, p) => s + p.amount, 0);
  logger.info(`[PENALTY] Driver ${driver.id} paid ${unpaid.length} penalty(ies), total ₹${totalPaid}`);
  res.json({
    success: true,
    message: `Penalty of ₹${totalPaid} paid. You can go online now.`,
    data: { paidCount: unpaid.length, totalPaid },
  });
}));

/**
 * @openapi
 * /api/driver/earnings:
 *   get:
 *     tags: [Earnings]
 *     summary: Get earnings summary
 *     description: Returns earnings breakdown for today, week, month, and total
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Earnings summary
 */
app.get('/api/driver/earnings', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const windowType = await getPlatformConfig('earnings_window_type', 'calendar');
  const platformFeeRate = parseFloat(await getPlatformConfig('platform_fee_rate', '0.20'));

  const driver = await prisma.driver.findFirst({
    where: { userId: req.user!.id },
    include: { earnings: { orderBy: { date: 'desc' } } },
  });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  const now = new Date();
  let today: Date;
  let weekStart: Date;
  let monthStart: Date;

  if (windowType === 'rolling_24h') {
    // Rolling 24-hour window
    today = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    monthStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else {
    // Calendar-based (default)
    today = new Date(now);
    today.setHours(0, 0, 0, 0);
    weekStart = new Date(today);
    weekStart.setDate(today.getDate() - 7);
    monthStart = new Date(today);
    monthStart.setMonth(today.getMonth() - 1);
  }

  const todayE = driver.earnings.filter((e) => e.date >= today);
  const weekE = driver.earnings.filter((e) => e.date >= weekStart);
  const monthE = driver.earnings.filter((e) => e.date >= monthStart);

  // Calculate real fare breakdowns from actual earnings
  const calcBreakdown = (earnings: typeof driver.earnings) => ({
    base_fare: earnings.reduce((s, e) => s + e.baseFare, 0),
    distance_fare: earnings.reduce((s, e) => s + e.distanceFare, 0),
    time_fare: earnings.reduce((s, e) => s + e.timeFare, 0),
    surge_bonus: earnings.reduce((s, e) => s + e.surgeFare, 0),
    gross_amount: earnings.reduce((s, e) => s + e.amount, 0),
    platform_fee: earnings.reduce((s, e) => s + e.commission, 0),
    net_amount: earnings.reduce((s, e) => s + e.netAmount, 0),
  });

  const allBreakdown = calcBreakdown(driver.earnings);
  const todayBreakdown = calcBreakdown(todayE);
  const weekBreakdown = calcBreakdown(weekE);
  const monthBreakdown = calcBreakdown(monthE);

  res.json({
    success: true,
    data: {
      rating: driver.rating,
      rating_count: driver.ratingCount,
      window_type: windowType,
      platform_fee_rate: platformFeeRate,
      today: {
        amount: todayE.reduce((s, e) => s + e.netAmount, 0),
        gross_amount: todayE.reduce((s, e) => s + e.amount, 0),
        platform_fee: todayE.reduce((s, e) => s + e.commission, 0),
        trips: todayE.length,
        average_per_trip: todayE.length ? todayE.reduce((s, e) => s + e.netAmount, 0) / todayE.length : 0,
        breakdown: todayBreakdown,
      },
      week: {
        amount: weekE.reduce((s, e) => s + e.netAmount, 0),
        gross_amount: weekE.reduce((s, e) => s + e.amount, 0),
        platform_fee: weekE.reduce((s, e) => s + e.commission, 0),
        trips: weekE.length,
        average_per_trip: weekE.length ? weekE.reduce((s, e) => s + e.netAmount, 0) / weekE.length : 0,
        breakdown: weekBreakdown,
      },
      month: {
        amount: monthE.reduce((s, e) => s + e.netAmount, 0),
        gross_amount: monthE.reduce((s, e) => s + e.amount, 0),
        platform_fee: monthE.reduce((s, e) => s + e.commission, 0),
        trips: monthE.length,
        average_per_trip: monthE.length ? monthE.reduce((s, e) => s + e.netAmount, 0) / monthE.length : 0,
        breakdown: monthBreakdown,
      },
      total: {
        amount: driver.totalEarnings,
        trips: driver.totalRides,
        hours_online: secondsToHours(driver.totalOnlineSeconds),
        average_per_trip: driver.totalRides ? driver.totalEarnings / driver.totalRides : 0,
        breakdown: allBreakdown,
      },
    },
  });
}));

/**
 * @openapi
 * /api/driver/earnings/transactions:
 *   get:
 *     tags: [Earnings]
 *     summary: List earning transactions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Transactions list
 */
app.get(
  '/api/driver/earnings/transactions',
  authenticateDriver,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('from').optional().isISO8601(),
    query('to').optional().isISO8601(),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const fromDate = req.query.from ? new Date(req.query.from as string) : undefined;
    const toDate = req.query.to ? new Date(req.query.to as string) : undefined;

    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const whereClause: any = { driverId: driver.id };
    if (fromDate || toDate) {
      whereClause.date = {};
      if (fromDate) whereClause.date.gte = fromDate;
      if (toDate) whereClause.date.lte = toDate;
    }

    const [earnings, total] = await Promise.all([
      prisma.driverEarning.findMany({
        where: whereClause,
        orderBy: { date: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.driverEarning.count({ where: whereClause }),
    ]);

    res.json({
      success: true,
      data: {
        transactions: earnings.map((e) => ({
          id: e.id,
          ride_id: e.rideId,
          gross_amount: e.amount,
          platform_fee: e.commission,
          platform_fee_rate: e.commissionRate,
          net_amount: e.netAmount,
          breakdown: {
            base_fare: e.baseFare,
            distance_fare: e.distanceFare,
            time_fare: e.timeFare,
            surge_bonus: e.surgeFare,
          },
          date: e.date.toISOString(),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page < Math.ceil(total / limit),
          hasPrev: page > 1,
        },
      },
    });
  }));

// ═══════════════════════════════════════════════════════════════════════════════
// PAYOUT ACCOUNT MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /api/driver/payout-accounts:
 *   get:
 *     tags: [Payout Accounts]
 *     summary: Get all payout accounts
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Payout accounts list
 */
app.get('/api/driver/payout-accounts', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  const accounts = await PayoutService.getPayoutAccounts(driver.id);
  res.json({ success: true, data: { accounts } });
}));

/**
 * @openapi
 * /api/driver/payout-accounts:
 *   post:
 *     tags: [Payout Accounts]
 *     summary: Add a payout account
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PayoutAccountRequest'
 *     responses:
 *       201:
 *         description: Account created
 *       400:
 *         description: Validation failed
 */
app.post(
  '/api/driver/payout-accounts',
  authenticateDriver,
  [
    body('accountType').isIn(['BANK_ACCOUNT', 'UPI']).withMessage('accountType must be BANK_ACCOUNT or UPI'),
    body('bankName').optional().isString(),
    body('accountNumber').optional().isString().isLength({ min: 9, max: 18 }),
    body('ifscCode').optional().matches(/^[A-Z]{4}0[A-Z0-9]{6}$/).withMessage('Invalid IFSC code'),
    body('accountHolderName').optional().isString().isLength({ min: 2, max: 100 }),
    body('upiId').optional().matches(/^[\w.-]+@[\w]+$/).withMessage('Invalid UPI ID format'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    try {
      const account = await PayoutService.createPayoutAccount({
        driverId: driver.id,
        accountType: req.body.accountType,
        bankName: req.body.bankName,
        accountNumber: req.body.accountNumber,
        ifscCode: req.body.ifscCode,
        accountHolderName: req.body.accountHolderName,
        upiId: req.body.upiId,
      });

      res.status(201).json({
        success: true,
        message: 'Payout account added successfully',
        data: {
          id: account.id,
          accountType: account.accountType,
          bankName: account.bankName,
          accountNumber: account.accountNumber,
          ifscCode: account.ifscCode,
          accountHolderName: account.accountHolderName,
          upiId: account.upiId,
          isPrimary: account.isPrimary,
          isVerified: account.isVerified,
        },
      });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  }));

/**
 * @openapi
 * /api/driver/payout-accounts/{id}/primary:
 *   put:
 *     tags: [Payout Accounts]
 *     summary: Set account as primary
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
 *         description: Primary account updated
 */
app.put('/api/driver/payout-accounts/:id/primary', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  try {
    await PayoutService.setPrimaryAccount(driver.id, req.params.id);
    res.json({ success: true, message: 'Primary account updated' });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
}));

/**
 * @openapi
 * /api/driver/payout-accounts/{id}:
 *   delete:
 *     tags: [Payout Accounts]
 *     summary: Delete a payout account
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
 *         description: Account deleted
 */
app.delete('/api/driver/payout-accounts/:id', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  try {
    await PayoutService.deletePayoutAccount(driver.id, req.params.id);
    res.json({ success: true, message: 'Payout account deleted' });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
}));

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET & WITHDRAWALS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @openapi
 * /api/driver/wallet:
 *   get:
 *     tags: [Wallet]
 *     summary: Get wallet balance
 *     description: Returns wallet balance, stats, and primary payout account
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Wallet details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/WalletBalance'
 */
app.get('/api/driver/wallet', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  const wallet = await PayoutService.getDriverWallet(driver.id);
  
  // Get primary payout account
  const primaryAccount = await prisma.driverPayoutAccount.findFirst({
    where: { driverId: driver.id, isPrimary: true },
    select: {
      id: true,
      accountType: true,
      bankName: true,
      accountNumber: true,
      upiId: true,
      isVerified: true,
    },
  });

  res.json({
    success: true,
    data: {
      balance: {
        available: wallet.availableBalance,
        pending: wallet.pendingBalance,
        hold: wallet.holdBalance,
        effective: wallet.effectiveBalance,
      },
      stats: {
        totalEarned: wallet.totalEarned,
        totalWithdrawn: wallet.totalWithdrawn,
        unpaidPenalties: wallet.unpaidPenalties,
        pendingWithdrawals: wallet.pendingWithdrawals,
      },
      minimumWithdrawal: wallet.minimumWithdrawal,
      lastPayoutAt: wallet.lastPayoutAt,
      primaryAccount,
    },
  });
}));

/**
 * @openapi
 * /api/driver/wallet/withdraw:
 *   post:
 *     tags: [Wallet]
 *     summary: Request a withdrawal
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amount]
 *             properties:
 *               amount:
 *                 type: number
 *                 minimum: 1
 *               payoutAccountId:
 *                 type: string
 *     responses:
 *       201:
 *         description: Withdrawal requested
 *       400:
 *         description: Insufficient balance or validation error
 */
app.post(
  '/api/driver/wallet/withdraw',
  authenticateDriver,
  [
    body('amount').isFloat({ min: 1 }).withMessage('Amount must be at least ₹1'),
    body('payoutAccountId').optional().isString(),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    try {
      const payout = await PayoutService.requestWithdrawal({
        driverId: driver.id,
        amount: req.body.amount,
        payoutAccountId: req.body.payoutAccountId,
      });

      res.status(201).json({
        success: true,
        message: 'Withdrawal request submitted',
        data: {
          payoutId: payout.id,
          amount: payout.amount,
          fee: payout.fee,
          netAmount: payout.netAmount,
          status: payout.status,
          payoutMethod: payout.payoutMethod,
          estimatedTime: payout.payoutMethod === 'UPI' ? 'Instant' : '1-2 business days',
        },
      });
    } catch (error: any) {
      res.status(400).json({ success: false, message: error.message });
    }
  })
);

/**
 * @openapi
 * /api/driver/wallet/transactions:
 *   get:
 *     tags: [Wallet]
 *     summary: Get wallet transactions
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
 *     responses:
 *       200:
 *         description: Transaction list
 */
app.get(
  '/api/driver/wallet/transactions',
  authenticateDriver,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await PayoutService.getWalletTransactions(driver.id, page, limit);

    res.json({
      success: true,
      data: {
        transactions: result.transactions.map(t => ({
          id: t.id,
          type: t.type,
          amount: t.amount,
          description: t.description,
          referenceType: t.referenceType,
          referenceId: t.referenceId,
          createdAt: t.createdAt,
        })),
        pagination: result.pagination,
      },
    });
  }));

/**
 * @openapi
 * /api/driver/wallet/payouts:
 *   get:
 *     tags: [Wallet]
 *     summary: Get payout history
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
 *     responses:
 *       200:
 *         description: Payout history
 */
app.get(
  '/api/driver/wallet/payouts',
  authenticateDriver,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const result = await PayoutService.getPayoutHistory(driver.id, page, limit);

    res.json({
      success: true,
      data: {
        payouts: result.payouts.map(p => ({
          id: p.id,
          amount: p.amount,
          fee: p.fee,
          netAmount: p.netAmount,
          status: p.status,
          payoutMethod: p.payoutMethod,
          transactionId: p.transactionId,
          failureReason: p.failureReason,
          requestedAt: p.requestedAt,
          completedAt: p.completedAt,
          account: p.payoutAccount ? {
            type: p.payoutAccount.accountType,
            bankName: p.payoutAccount.bankName,
            accountNumber: p.payoutAccount.accountNumber,
            upiId: p.payoutAccount.upiId,
          } : null,
        })),
        pagination: result.pagination,
      },
    });
  })
);

/**
 * @openapi
 * /api/driver/trips:
 *   get:
 *     tags: [Trips]
 *     summary: Get trip history
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
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Trip history
 */
app.get(
  '/api/driver/trips',
  authenticateDriver,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: MAX_PAGINATION_LIMIT }).withMessage(`limit must be between 1 and ${MAX_PAGINATION_LIMIT}`),
    query('status').optional().isString().withMessage('status must be a string'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    // Use sanitized pagination with max limit enforcement
    const { page, limit } = sanitizePagination(req.query.page as string, req.query.limit as string);
    const status = req.query.status as string | undefined;

    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const whereClause: any = { driverId: driver.id };
    if (status) {
      whereClause.status = status.toUpperCase();
    }

    const [rides, totalTrips] = await Promise.all([
      prisma.ride.findMany({
        where: whereClause,
        include: { passenger: { select: { firstName: true, lastName: true, phone: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.ride.count({ where: whereClause }),
    ]);

    const trips = rides.map((r) => ({
      trip_id: r.id,
      passenger_name: `${r.passenger.firstName} ${r.passenger.lastName || ''}`.trim(),
      passenger_phone: r.passenger.phone,
      pickup_address: r.pickupAddress,
      drop_address: r.dropAddress,
      distance: r.distance,
      duration: r.duration,
      fare: r.totalFare,
      status: r.status.toLowerCase(),
      rating: r.passengerRating ?? null, // Real rating from ride (null if not rated)
      feedback: r.passengerFeedback ?? null,
      rated_at: r.ratedByPassengerAt?.toISOString() ?? null,
      cancelled_by: r.cancelledBy ?? null,
      started_at: r.startedAt?.toISOString() ?? null,
      completed_at: r.completedAt?.toISOString() ?? null,
      created_at: r.createdAt.toISOString(),
    }));

    res.json({
      success: true,
      data: {
        trips,
        pagination: {
          page,
          limit,
          total: totalTrips,
          totalPages: Math.ceil(totalTrips / limit),
          hasNext: page < Math.ceil(totalTrips / limit),
          hasPrev: page > 1,
        },
      },
    });
  })
);

/**
 * @openapi
 * /api/driver/support:
 *   post:
 *     tags: [Support]
 *     summary: Submit support ticket
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [issue_type, description]
 *             properties:
 *               issue_type:
 *                 type: string
 *               description:
 *                 type: string
 *               priority:
 *                 type: string
 *                 enum: [low, medium, high]
 *     responses:
 *       201:
 *         description: Ticket created
 */
app.post(
  '/api/driver/support',
  authenticateDriver,
  [
    body('issue_type').isString().notEmpty().trim().isLength({ min: 1, max: 100 }).withMessage('Issue type is required (max 100 chars)'),
    body('description').isString().notEmpty().trim().isLength({ min: 10, max: 2000 }).withMessage('Description is required (10-2000 chars)'),
    body('priority').optional().isIn(['low', 'medium', 'high']).withMessage('Priority must be low, medium, or high'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const { issue_type, description, priority } = req.body;

    const priorityMap: { [key: string]: 'LOW' | 'MEDIUM' | 'HIGH' } = {
      low: 'LOW',
      medium: 'MEDIUM',
      high: 'HIGH',
    };

    const ticket = await prisma.supportTicket.create({
      data: {
        driverId: driver.id,
        issueType: issue_type,
        description,
        priority: priorityMap[priority || 'medium'],
      },
    });

    logger.info(`[SUPPORT] Driver ${driver.id} created support ticket ${ticket.id}`);

    res.status(201).json({
      success: true,
      message: 'Support request submitted successfully',
      data: {
        request_id: ticket.id,
        driver_id: driver.id,
        issue_type: ticket.issueType,
        description: ticket.description,
        priority: ticket.priority.toLowerCase(),
        status: ticket.status.toLowerCase(),
        created_at: ticket.createdAt.toISOString(),
      },
    });
  })
);

/**
 * @openapi
 * /api/driver/support:
 *   get:
 *     tags: [Support]
 *     summary: List support tickets
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
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [open, in_progress, resolved, closed]
 *     responses:
 *       200:
 *         description: Support tickets list
 */
app.get(
  '/api/driver/support',
  authenticateDriver,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
    query('status').optional().isIn(['open', 'in_progress', 'resolved', 'closed']),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    const statusFilter = req.query.status as string | undefined;

    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const whereClause: any = { driverId: driver.id };
    if (statusFilter) {
      const statusMap: { [key: string]: string } = {
        open: 'OPEN',
        in_progress: 'IN_PROGRESS',
        resolved: 'RESOLVED',
        closed: 'CLOSED',
      };
      whereClause.status = statusMap[statusFilter];
    }

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.supportTicket.count({ where: whereClause }),
    ]);

    res.json({
      success: true,
      data: {
        tickets: tickets.map((t) => ({
          request_id: t.id,
          issue_type: t.issueType,
          description: t.description,
          priority: t.priority.toLowerCase(),
          status: t.status.toLowerCase().replace('_', '-'),
          response: t.response,
          responded_at: t.respondedAt?.toISOString() ?? null,
          created_at: t.createdAt.toISOString(),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page < Math.ceil(total / limit),
          hasPrev: page > 1,
        },
      },
    });
  })
);

/**
 * @openapi
 * /api/driver/support/{id}:
 *   get:
 *     tags: [Support]
 *     summary: Get support ticket
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
 *         description: Support ticket details
 *       404:
 *         description: Ticket not found
 */
app.get('/api/driver/support/:id', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const { id } = req.params;

  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  const ticket = await prisma.supportTicket.findFirst({
    where: { id, driverId: driver.id },
  });

  if (!ticket) {
    res.status(404).json({ success: false, message: 'Support ticket not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      request_id: ticket.id,
      issue_type: ticket.issueType,
      description: ticket.description,
      priority: ticket.priority.toLowerCase(),
      status: ticket.status.toLowerCase().replace('_', '-'),
      response: ticket.response,
      responded_at: ticket.respondedAt?.toISOString() ?? null,
      created_at: ticket.createdAt.toISOString(),
      updated_at: ticket.updatedAt.toISOString(),
    },
  });
}));

// ==================== DRIVER SETTINGS ====================

/**
 * @openapi
 * /api/driver/settings:
 *   get:
 *     tags: [Settings]
 *     summary: Get driver settings
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Driver settings
 */
app.get('/api/driver/settings', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({
    where: { userId: req.user!.id },
    include: { user: true },
  });

  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      profile: {
        name: `${driver.user.firstName} ${driver.user.lastName || ''}`.trim(),
        email: driver.user.email,
        phone: driver.user.phone,
        profile_image: driver.user.profileImage,
      },
      vehicle: {
        type: driver.vehicleType,
        model: driver.vehicleModel,
        color: driver.vehicleColor,
        year: driver.vehicleYear,
        license_plate: driver.vehicleNumber,
      },
      preferences: {
        notifications_enabled: driver.notificationsEnabled,
        preferred_language: driver.preferredLanguage,
        service_types: driver.serviceTypes,
      },
    },
  });
}));

/**
 * @openapi
 * /api/driver/settings:
 *   put:
 *     tags: [Settings]
 *     summary: Update driver settings
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notifications_enabled:
 *                 type: boolean
 *               preferred_language:
 *                 type: string
 *               vehicle_model:
 *                 type: string
 *               vehicle_color:
 *                 type: string
 *               vehicle_year:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Settings updated
 */
app.put(
  '/api/driver/settings',
  authenticateDriver,
  [
    body('notifications_enabled').optional().isBoolean(),
    body('preferred_language').optional().isString(),
    body('vehicle_model').optional().isString(),
    body('vehicle_color').optional().isString(),
    body('vehicle_year').optional().isInt({ min: 1990, max: 2030 }),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const { notifications_enabled, preferred_language, vehicle_model, vehicle_color, vehicle_year } = req.body;

    const updated = await prisma.driver.update({
      where: { id: driver.id },
      data: {
        ...(notifications_enabled !== undefined && { notificationsEnabled: notifications_enabled }),
        ...(preferred_language !== undefined && { preferredLanguage: preferred_language }),
        ...(vehicle_model !== undefined && { vehicleModel: vehicle_model }),
        ...(vehicle_color !== undefined && { vehicleColor: vehicle_color }),
        ...(vehicle_year !== undefined && { vehicleYear: vehicle_year }),
      },
      include: { user: true },
    });

    logger.info(`[SETTINGS] Driver ${driver.id} updated settings`);

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: {
        profile: {
          name: `${updated.user.firstName} ${updated.user.lastName || ''}`.trim(),
          email: updated.user.email,
          phone: updated.user.phone,
        },
        vehicle: {
          model: updated.vehicleModel,
          color: updated.vehicleColor,
          year: updated.vehicleYear,
          license_plate: updated.vehicleNumber,
        },
        preferences: {
          notifications_enabled: updated.notificationsEnabled,
          preferred_language: updated.preferredLanguage,
        },
      },
    });
  })
);

// ==================== ONBOARDING ENDPOINTS ====================

/**
 * @openapi
 * /api/driver/onboarding/start:
 *   post:
 *     tags: [Onboarding]
 *     summary: Start driver onboarding
 *     description: Creates driver profile or returns existing one
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Existing driver profile
 *       201:
 *         description: New driver profile created
 */
app.post('/api/driver/onboarding/start', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  let driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (driver) {
    res.json({ success: true, message: 'Driver profile found', data: { driver_id: driver.id, onboarding_status: driver.onboardingStatus, current_step: driver.onboardingStatus } });
    return;
  }
  driver = await prisma.driver.create({ data: { userId: req.user!.id, onboardingStatus: OnboardingStatus.EMAIL_COLLECTION } });
  res.status(201).json({ success: true, message: 'Driver onboarding started', data: { driver_id: driver.id, onboarding_status: driver.onboardingStatus, current_step: 'EMAIL_COLLECTION' } });
}));

/**
 * Step 1b: Email collection (for users who signed up with phone only)
 */
app.put(
  '/api/driver/onboarding/email',
  authenticate,
  [
    body('email').isEmail().withMessage('Valid email is required'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { email } = req.body;
    
    // Check if email is already in use
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser && existingUser.id !== req.user!.id) {
      res.status(409).json({ success: false, message: 'Email is already in use by another account' });
      return;
    }
    
    // Update user's email
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { email: email.toLowerCase() },
    });
    
    // Update driver onboarding status
    const driver = await prisma.driver.update({
      where: { userId: req.user!.id },
      data: { onboardingStatus: OnboardingStatus.LANGUAGE_SELECTION },
    });
    
    res.json({
      success: true,
      message: 'Email saved successfully',
      data: {
        driver_id: driver.id,
        email: email.toLowerCase(),
        next_step: 'LANGUAGE_SELECTION',
      },
    });
  })
);

/**
 * Step 2: Language selection + email setup
 */
app.put('/api/driver/onboarding/language', authenticate, [body('language').notEmpty()], asyncHandler(async (req: AuthRequest, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, errors: errors.array() });
    return;
  }
  const driver = await prisma.driver.update({ where: { userId: req.user!.id }, data: { preferredLanguage: req.body.language, onboardingStatus: OnboardingStatus.EARNING_SETUP } });
  res.json({ success: true, message: 'Language preference saved', data: { driver_id: driver.id, language: driver.preferredLanguage, next_step: 'EARNING_SETUP' } });
}));

/**
 * Step 3: Vehicle type selection + referral code
 */
app.put(
  '/api/driver/onboarding/vehicle',
  authenticate,
  [
    body('vehicleType').notEmpty().withMessage('Vehicle type is required'),
    body('serviceTypes').isArray().withMessage('Service types must be an array'),
    body('referralCode').optional().isString(),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }
    
    const { vehicleType, serviceTypes, referralCode } = req.body;
    
    const driver = await prisma.driver.update({
      where: { userId: req.user!.id },
      data: {
        vehicleType,
        serviceTypes,
        referralCode: referralCode || null,
        onboardingStatus: OnboardingStatus.LICENSE_UPLOAD,
      },
    });
    
    res.json({
      success: true,
      message: 'Vehicle information saved',
      data: {
        driver_id: driver.id,
        vehicle_type: driver.vehicleType,
        service_types: driver.serviceTypes,
        referral_code: driver.referralCode,
        next_step: 'LICENSE_UPLOAD',
      },
    });
  })
);

/**
 * Step 4: Personal information (name, Aadhaar, PAN, vehicle registration)
 */
app.put(
  '/api/driver/onboarding/personal-info',
  authenticate,
  [
    body('fullName').optional().isString().isLength({ min: 2, max: 100 }).withMessage('Full name must be 2-100 characters'),
    body('aadhaarNumber').optional().matches(/^\d{12}$/).withMessage('Aadhaar must be 12 digits'),
    body('panNumber').optional().matches(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/).withMessage('Invalid PAN format (e.g., ABCDE1234F)'),
    body('vehicleRegistrationNumber').optional().isString().withMessage('Vehicle registration number is required'),
    body('vehicleModel').optional().isString(),
    body('vehicleColor').optional().isString(),
    body('vehicleYear').optional().isInt({ min: 1990, max: new Date().getFullYear() + 1 }),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { fullName, aadhaarNumber, panNumber, vehicleRegistrationNumber, vehicleModel, vehicleColor, vehicleYear } = req.body;
    
    // Check if Aadhaar is already registered
    if (aadhaarNumber) {
      const existingAadhaar = await prisma.driver.findFirst({
        where: { aadhaarNumber, userId: { not: req.user!.id } },
      });
      if (existingAadhaar) {
        res.status(409).json({ success: false, message: 'Aadhaar number is already registered with another account' });
        return;
      }
    }
    
    // Check if PAN is already registered
    if (panNumber) {
      const existingPan = await prisma.driver.findFirst({
        where: { panNumber, userId: { not: req.user!.id } },
      });
      if (existingPan) {
        res.status(409).json({ success: false, message: 'PAN number is already registered with another account' });
        return;
      }
    }
    
    // Check if vehicle registration is already registered
    if (vehicleRegistrationNumber) {
      const existingVehicle = await prisma.driver.findFirst({
        where: { vehicleNumber: vehicleRegistrationNumber, userId: { not: req.user!.id } },
      });
      if (existingVehicle) {
        res.status(409).json({ success: false, message: 'Vehicle registration number is already registered' });
        return;
      }
    }
    
    // Update user's name if provided
    if (fullName) {
      const nameParts = fullName.trim().split(' ');
      const firstName = nameParts[0];
      const lastName = nameParts.slice(1).join(' ') || undefined;
      
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { firstName, lastName },
      });
    }
    
    // Update driver info
    const updateData: any = {};
    if (aadhaarNumber) updateData.aadhaarNumber = aadhaarNumber;
    if (panNumber) updateData.panNumber = panNumber.toUpperCase();
    if (vehicleRegistrationNumber) updateData.vehicleNumber = vehicleRegistrationNumber.toUpperCase();
    if (vehicleModel) updateData.vehicleModel = vehicleModel;
    if (vehicleColor) updateData.vehicleColor = vehicleColor;
    if (vehicleYear) updateData.vehicleYear = vehicleYear;
    updateData.onboardingStatus = OnboardingStatus.DOCUMENT_UPLOAD;
    
    const driver = await prisma.driver.update({
      where: { userId: req.user!.id },
      data: updateData,
      include: { user: true },
    });
    
    res.json({
      success: true,
      message: 'Personal information saved',
      data: {
        driver_id: driver.id,
        full_name: `${driver.user.firstName} ${driver.user.lastName || ''}`.trim(),
        aadhaar_number: driver.aadhaarNumber ? `XXXX-XXXX-${driver.aadhaarNumber.slice(-4)}` : null,
        pan_number: driver.panNumber ? `${driver.panNumber.slice(0, 2)}XXXXX${driver.panNumber.slice(-2)}` : null,
        vehicle_number: driver.vehicleNumber,
        next_step: 'DOCUMENT_UPLOAD',
      },
    });
  })
);

/**
 * Pre-upload middleware: validates documentType and fetches driver info
 * Sets req.driverInfo so multer can use it for file naming
 * 
 * URL format: /api/driver/onboarding/document/upload?documentType=LICENSE
 */
const preUploadMiddleware = asyncHandler(async (req: AuthRequest, res, next) => {
  // Get documentType from query params (preferred) or body
  const documentType = (req.params?.type as string) || (req.query.documentType as string) || req.body?.documentType;
  
  if (!documentType) {
    res.status(400).json({ 
      success: false, 
      message: 'Document type is required. Pass as query param: ?documentType=LICENSE',
      validTypes: REQUIRED_DOCUMENTS,
    });
    return;
  }
  
  const docType = documentType.toUpperCase();
  if (!REQUIRED_DOCUMENTS.includes(docType as any)) {
    res.status(400).json({ 
      success: false, 
      message: `Invalid document type: ${docType}`,
      validTypes: REQUIRED_DOCUMENTS,
    });
    return;
  }
  
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  
  // For update flow (PUT /api/driver/documents/:type), keep existing approved
  // document history until new one is verified.
  const isUpdateRoute = req.method === 'PUT' && Boolean(req.params?.type);
  if (!isUpdateRoute) {
    // Delete old document if re-uploading in onboarding flow
    try {
      await deleteOldDocument(driver.id, docType);
    } catch (err: any) {
      logger.warn(`[UPLOAD] Failed to delete old document from storage: ${err.message}`);
      // Continue anyway - old file might not exist
    }
    
    // Also delete from database if re-uploading in onboarding flow
    try {
      await prisma.driverDocument.deleteMany({
        where: { driverId: driver.id, documentType: docType as DocumentType },
      });
    } catch (err: any) {
      logger.warn(`[UPLOAD] Failed to delete old document from DB: ${err.message}`);
      // Continue anyway
    }
  }
  
  // Set driver info for multer to use in file naming
  req.driverInfo = {
    id: driver.id,
    documentType: docType,
  };
  
  logger.info(`[UPLOAD] Pre-upload: driver=${driver.id}, type=${docType}`);
  next();
});

// Wrapper to handle multer errors
const handleMulterUpload = (req: AuthRequest, res: express.Response, next: express.NextFunction) => {
  upload.single('document')(req, res, (err: any) => {
    if (err) {
      logger.error(`[UPLOAD] Multer error: ${err.message}`, { 
        code: err.code, 
        field: err.field,
        storageType: getStorageConfig().type,
      });
      
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'File too large. Maximum size is 10MB.' });
      }
      if (err.message?.includes('Only .png, .jpg')) {
        return res.status(400).json({ success: false, message: err.message });
      }
      
      return res.status(500).json({ 
        success: false, 
        message: 'File upload failed',
        error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
      });
    }
    next();
  });
};

const handleDriverDocumentUpload = asyncHandler(async (req: AuthRequest, res: express.Response) => {
    if (!req.file) {
      logger.error('[UPLOAD] No file in request after multer processing');
      res.status(400).json({ success: false, message: 'No file uploaded' });
      return;
    }
    
    logger.info(`[UPLOAD] File received: ${req.file.originalname}, size: ${req.file.size}, mimetype: ${req.file.mimetype}`);
    
    const driverId = req.driverInfo!.id;
    const docType = req.driverInfo!.documentType;
    
    const documentUrl = getDocumentUrl(req.file as Express.Multer.File & { key?: string; location?: string }, docType);
    
    // For PROFILE_PHOTO: auto-verify immediately (no OCR needed)
    const isProfilePhoto = docType === 'PROFILE_PHOTO';
    
    const document = await prisma.driverDocument.create({
      data: {
        driverId,
        documentType: docType as DocumentType,
        documentUrl,
        documentName: req.file.originalname,
        documentSize: req.file.size,
        verificationStatus: isProfilePhoto ? 'verified' : 'pending',
        isVerified: isProfilePhoto,
        verifiedAt: isProfilePhoto ? new Date() : null,
        verifiedBy: isProfilePhoto ? 'AUTO_APPROVED' : null,
      },
    });
    
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    let newStatus = driver!.onboardingStatus;
    const isOnboardingUploadRoute = req.path.includes('/onboarding/document/upload');
    if (isOnboardingUploadRoute) {
      if (docType === 'LICENSE') newStatus = OnboardingStatus.PROFILE_PHOTO;
      else if (docType === 'PROFILE_PHOTO') newStatus = OnboardingStatus.PHOTO_CONFIRMATION;
      await prisma.driver.update({ where: { id: driverId }, data: { onboardingStatus: newStatus } });
    }
    
    // For PROFILE_PHOTO: also update the user's profileImage field
    if (isProfilePhoto && driver?.userId) {
      await prisma.user.update({
        where: { id: driver.userId },
        data: { profileImage: documentUrl },
      });
      logger.info(`[UPLOAD] Updated user profile image for driver ${driverId}`);
      
      // Check if all documents are now verified (profile photo was the last one)
      const allDocs = await prisma.driverDocument.findMany({
        where: { driverId },
        select: { documentType: true, isVerified: true },
      });
      const docCheck = checkRequiredDocuments(allDocs.map((d) => d.documentType));
      const allVerified = allDocs.length > 0 && allDocs.every((d) => d.isVerified);
      
      if (docCheck.isComplete && allVerified) {
        await prisma.driver.update({
          where: { id: driverId },
          data: {
            onboardingStatus: OnboardingStatus.COMPLETED,
            isVerified: true,
            documentsVerifiedAt: new Date(),
            verificationNotes: 'All documents verified. Profile photo auto-approved.',
          },
        });
        newStatus = OnboardingStatus.COMPLETED;
        logger.info(`[UPLOAD] Driver ${driverId} auto-completed - all documents verified`);
      }
    }
    
    logger.info(`[DOCUMENT] Uploaded ${docType} for driver ${driverId}, file: ${documentUrl}, storage: ${getStorageConfig().type}`);
    
    // Queue async verification if Vision API and Redis are available
    let verificationQueued = false;
    const supportedTypes = ['LICENSE', 'PAN_CARD', 'AADHAAR_CARD', 'RC', 'INSURANCE'];
    
    if (isVisionConfigured() && isQueueAvailable() && supportedTypes.includes(docType)) {
      try {
        await addVerificationJob(document.id, driverId, docType, documentUrl);
        verificationQueued = true;
        logger.info(`[QUEUE] Verification job queued for ${docType} (document ${document.id})`);
      } catch (err: any) {
        logger.error(`[QUEUE] Failed to queue verification job`, { error: err.message || err });
      }
    }

    res.status(201).json({ 
      success: true, 
      message: isOnboardingUploadRoute
        ? 'Document uploaded successfully'
        : 'Document updated successfully and sent for verification',
      data: { 
        document_id: document.id, 
        document_type: document.documentType, 
        document_url: document.documentUrl, 
        file_name: (((req.file as any).key as string | undefined)?.split('/').pop()) ?? req.file.filename ?? req.file.originalname,
        uploaded_at: document.uploadedAt, 
        next_step: newStatus,
        storage_type: getStorageConfig().type,
        verification_status: 'pending',
        verification_queued: verificationQueued,
      } 
    });
  });

app.post(
  '/api/driver/onboarding/document/upload',
  authenticate,
  preUploadMiddleware,
  handleMulterUpload,
  handleDriverDocumentUpload
);

/**
 * @openapi
 * /api/driver/documents/{type}:
 *   put:
 *     tags: [Driver Onboarding]
 *     summary: Update an already uploaded driver document
 *     description: |
 *       Re-upload a specific document type for an onboarded driver.
 *       The newly uploaded file is stored as a fresh document entry and sent for verification.
 *       Existing approved documents remain available in history until the new upload is verified.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [LICENSE, RC, INSURANCE, PAN_CARD, AADHAAR_CARD, PROFILE_PHOTO]
 *         description: Document type to replace
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [document]
 *             properties:
 *               document:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Document updated and queued for verification
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Document updated successfully and sent for verification
 *                 data:
 *                   type: object
 *                   properties:
 *                     document_id:
 *                       type: string
 *                     document_type:
 *                       type: string
 *                     document_url:
 *                       type: string
 *                     uploaded_at:
 *                       type: string
 *                       format: date-time
 *                     verification_status:
 *                       type: string
 *                       example: pending
 *       400:
 *         description: Invalid document type or no file uploaded
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Driver profile not found
 */
app.put(
  '/api/driver/documents/:type',
  authenticate,
  preUploadMiddleware,
  handleMulterUpload,
  handleDriverDocumentUpload
);

app.post('/api/driver/onboarding/documents/submit', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id }, include: { documents: true } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  const uploaded = driver.documents.map((d) => d.documentType);
  const docCheck = checkRequiredDocuments(uploaded);
  if (!docCheck.isComplete) {
    res.status(400).json({ success: false, message: 'Missing required documents', data: { missing_documents: docCheck.missing, required_documents: [...REQUIRED_DOCUMENTS] } });
    return;
  }

  const allAiVerified = driver.documents.every((d) => d.isVerified);
  if (allAiVerified && docCheck.isComplete) {
    await prisma.driver.update({
      where: { id: driver.id },
      data: {
        onboardingStatus: OnboardingStatus.COMPLETED,
        isVerified: true,
        documentsSubmittedAt: new Date(),
        documentsVerifiedAt: new Date(),
        verificationNotes: 'All documents auto-verified by AI Vision.',
      },
    });
    res.json({
      success: true,
      message: 'All documents were auto-verified! You can start accepting rides.',
      data: {
        driver_id: driver.id,
        status: 'COMPLETED',
        auto_verified: true,
        submitted_at: new Date(),
      },
    });
    return;
  }

  await prisma.driver.update({ where: { id: driver.id }, data: { onboardingStatus: OnboardingStatus.DOCUMENT_VERIFICATION, documentsSubmittedAt: new Date() } });

  const verificationSummary = driver.documents.map((d: any) => ({
    type: d.documentType,
    verification_status: d.verificationStatus,
    ai_verified: d.aiVerified,
    ai_confidence: d.aiConfidence,
    mismatch_reason: d.aiMismatchReason,
  }));
  const pendingCount = verificationSummary.filter((d) => d.verification_status !== 'verified').length;

  res.json({
    success: true,
    message: pendingCount > 0
      ? `${pendingCount} document(s) pending verification. Estimated wait: 24-48 hours.`
      : 'Documents submitted for verification',
    data: {
      driver_id: driver.id,
      status: 'DOCUMENT_VERIFICATION',
      submitted_at: new Date(),
      verification_summary: verificationSummary,
      pending_count: pendingCount,
      estimated_verification_time: pendingCount > 0 ? '24-48 hours' : 'instant',
    },
  });
}));

/**
 * Get verification status for a specific document
 */
app.get('/api/driver/documents/:id/verification-status', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { id } = req.params;
  
  const document = await prisma.driverDocument.findUnique({
    where: { id },
    include: { driver: true },
  });
  
  if (!document) {
    res.status(404).json({ success: false, message: 'Document not found' });
    return;
  }
  
  if (document.driver.userId !== req.user!.id) {
    res.status(403).json({ success: false, message: 'Access denied' });
    return;
  }
  
  res.json({
    success: true,
    data: {
      document_id: document.id,
      document_type: document.documentType,
      verification_status: document.verificationStatus,
      is_verified: document.isVerified,
      ai_verified: document.aiVerified,
      ai_confidence: document.aiConfidence,
      ai_extracted_data: document.aiExtractedData,
      ai_verified_at: document.aiVerifiedAt,
      mismatch_reason: document.aiMismatchReason,
      verified_at: document.verifiedAt,
      verified_by: document.verifiedBy,
      rejection_reason: document.rejectionReason,
    },
  });
}));

/**
 * @openapi
 * /api/driver/onboarding/status:
 *   get:
 *     tags: [Onboarding]
 *     summary: Get onboarding status
 *     description: Returns detailed onboarding and verification status
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Onboarding status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/OnboardingStatus'
 *       404:
 *         description: Driver not found
 */
app.get('/api/driver/onboarding/status', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id }, include: { documents: true, user: true } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  
  const allDocsVerified = driver.documents.length > 0 && driver.documents.every((d) => d.isVerified);
  const verifiedDocs = driver.documents.filter((d) => d.isVerified);
  const flaggedDocs = driver.documents.filter((d) => !d.isVerified && (d.verificationStatus === 'flagged' || d.verificationStatus === 'failed'));
  const pendingDocs = driver.documents.filter((d) => !d.isVerified && d.verificationStatus !== 'flagged' && d.verificationStatus !== 'failed');
  
  // Calculate verification progress percentage using shared constants
  const requiredDocs = [...REQUIRED_DOCUMENTS];
  const uploadedDocTypes = driver.documents.map(d => d.documentType);
  const verifiedDocTypes = verifiedDocs.map(d => d.documentType);
  
  const totalSteps = requiredDocs.length + 2; // +2 for aadhaar and pan verification
  let completedSteps = verifiedDocTypes.length;
  if (driver.aadhaarVerified) completedSteps++;
  if (driver.panVerified) completedSteps++;
  const verificationProgress = Math.round((completedSteps / totalSteps) * 100);
  
  res.json({
    success: true,
    data: {
      driver_id: driver.id,
      onboarding_status: driver.onboardingStatus,
      current_step: driver.onboardingStatus,
      is_verified: driver.isVerified,
      is_onboarding_complete: driver.onboardingStatus === OnboardingStatus.COMPLETED,
      
      // Personal info
      full_name: `${driver.user.firstName} ${driver.user.lastName || ''}`.trim(),
      email: driver.user.email,
      phone: driver.user.phone,
      preferred_language: driver.preferredLanguage,
      
      // Vehicle info
      vehicle_type: driver.vehicleType,
      vehicle_number: driver.vehicleNumber,
      vehicle_model: driver.vehicleModel,
      
      // KYC verification status
      kyc: {
        aadhaar: {
          number: driver.aadhaarNumber ? `XXXX-XXXX-${driver.aadhaarNumber.slice(-4)}` : null,
          verified: driver.aadhaarVerified,
          verified_at: driver.aadhaarVerifiedAt,
        },
        pan: {
          number: driver.panNumber ? `${driver.panNumber.slice(0, 2)}XXXXX${driver.panNumber.slice(-2)}` : null,
          verified: driver.panVerified,
          verified_at: driver.panVerifiedAt,
        },
        digilocker_linked: driver.digilockerLinked,
      },
      
      // Document verification status
      documents: {
        required: requiredDocs,
        uploaded: uploadedDocTypes,
        verified: verifiedDocTypes,
        pending: pendingDocs.map((d) => ({
          type: d.documentType,
          url: d.documentUrl,
          uploaded_at: d.uploadedAt,
          rejection_reason: d.rejectionReason,
          verification_status: d.verificationStatus,
          ai_verified: d.aiVerified,
          ai_confidence: d.aiConfidence,
          ai_mismatch_reason: d.aiMismatchReason,
        })),
        flagged: flaggedDocs.map((d) => ({
          type: d.documentType,
          url: d.documentUrl,
          uploaded_at: d.uploadedAt,
          rejection_reason: d.rejectionReason,
          verification_status: d.verificationStatus,
          ai_verified: d.aiVerified,
          ai_confidence: d.aiConfidence,
          ai_mismatch_reason: d.aiMismatchReason,
        })),
        details: driver.documents.map(d => ({
          type: d.documentType,
          url: d.documentUrl,
          uploaded_at: d.uploadedAt,
          is_verified: d.isVerified,
          verified_at: d.verifiedAt,
          rejection_reason: d.rejectionReason,
          verification_status: d.verificationStatus,
          ai_verified: d.aiVerified,
          ai_confidence: d.aiConfidence,
          ai_mismatch_reason: d.aiMismatchReason,
        })),
      },
      
      // Overall status
      documents_submitted: driver.documentsSubmittedAt != null,
      documents_submitted_at: driver.documentsSubmittedAt,
      documents_verified: allDocsVerified,
      documents_verified_at: driver.documentsVerifiedAt,
      verification_progress: verificationProgress,
      can_start_rides: canDriverStartRides(driver),
      verification_notes: driver.verificationNotes,
      
      // Timestamps
      joined_at: driver.joinedAt,
    },
  });
}));

// ==================== DIGILOCKER INTEGRATION ====================

/**
 * Get DigiLocker integration status
 */
app.get('/api/driver/digilocker/status', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const configStatus = DigiLocker.getConfigStatus();
  
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  
  res.json({
    success: true,
    data: {
      digilocker_configured: configStatus.configured,
      sandbox_mode: configStatus.sandboxMode,
      driver_linked: driver?.digilockerLinked || false,
      aadhaar_verified: driver?.aadhaarVerified || false,
    },
  });
}));

/**
 * Initiate DigiLocker OAuth flow
 * Returns authorization URL for user to authenticate
 */
app.post('/api/driver/digilocker/initiate', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  if (!DigiLocker.isDigiLockerConfigured()) {
    res.status(503).json({
      success: false,
      message: 'DigiLocker integration is not configured. Please contact support.',
    });
    return;
  }
  
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found. Please start onboarding first.' });
    return;
  }
  
  try {
    const { url, state } = DigiLocker.generateAuthorizationUrl(driver.id);
    
    res.json({
      success: true,
      message: 'DigiLocker authorization URL generated',
      data: {
        authorization_url: url,
        state,
        instructions: [
          '1. Open the authorization URL in a browser',
          '2. Login to DigiLocker with your Aadhaar-linked mobile',
          '3. Authorize Raahi to access your documents',
          '4. You will be redirected back to complete verification',
        ],
      },
    });
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Initiate error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
}));

/**
 * DigiLocker OAuth callback
 * Handles the redirect from DigiLocker after user authorization
 */
app.get('/api/driver/digilocker/callback', asyncHandler(async (req, res) => {
  const { code, state, error, error_description } = req.query;
  
  if (error) {
    logger.warn(`[DIGILOCKER] Callback error: ${error} - ${error_description}`);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/driver/digilocker/error?message=${encodeURIComponent(error_description as string || error as string)}`);
    return;
  }
  
  if (!code || !state) {
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/driver/digilocker/error?message=Missing authorization code or state`);
    return;
  }
  
  try {
    // Exchange code for tokens
    const { tokens, driverId } = await DigiLocker.exchangeCodeForToken(code as string, state as string);
    
    // Get user details and verify Aadhaar
    const verificationResult = await DigiLocker.verifyAadhaarViaDigiLocker(tokens.accessToken);
    
    if (verificationResult.verified) {
      // Validate aadhaarLastFour is exactly 4 digits
      const aadhaarLastFour = verificationResult.aadhaarLastFour;
      if (!/^\d{4}$/.test(aadhaarLastFour)) {
        logger.error(`[DIGILOCKER] Invalid Aadhaar format from DigiLocker: ${aadhaarLastFour}`);
        res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/driver/digilocker/error?message=Invalid Aadhaar data received`);
        return;
      }
      
      // FIXED: Encrypt token before storing, store consistent masked Aadhaar format
      const encryptedToken = DigiLocker.encryptSensitiveData(tokens.accessToken);
      const encryptedRefreshToken = tokens.refreshToken ? DigiLocker.encryptSensitiveData(tokens.refreshToken) : null;
      
      // Update driver with DigiLocker data
      await prisma.driver.update({
        where: { id: driverId },
        data: {
          digilockerLinked: true,
          digilockerToken: encryptedToken, // Now encrypted
          aadhaarVerified: true,
          aadhaarVerifiedAt: new Date(),
          // FIXED: Consistent format - always store masked (XXXXXXXX + last 4 digits)
          aadhaarNumber: `XXXXXXXX${aadhaarLastFour}`,
        },
      });
      
      // Update user name if available from DigiLocker
      if (verificationResult.name) {
        const driver = await prisma.driver.findUnique({ where: { id: driverId } });
        if (driver) {
          const nameParts = verificationResult.name.trim().split(' ');
          await prisma.user.update({
            where: { id: driver.userId },
            data: {
              firstName: nameParts[0],
              lastName: nameParts.slice(1).join(' ') || undefined,
            },
          });
        }
      }
      
      logger.info(`[DIGILOCKER] Aadhaar verified for driver ${driverId}`);
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/driver/digilocker/success`);
    } else {
      res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/driver/digilocker/error?message=Aadhaar verification failed`);
    }
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Callback processing error: ${error.message}`);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}/driver/digilocker/error?message=${encodeURIComponent(error.message)}`);
  }
}));

/**
 * Get documents from DigiLocker
 * Requires DigiLocker to be linked
 */
app.get('/api/driver/digilocker/documents', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  
  if (!driver.digilockerLinked || !driver.digilockerToken) {
    res.status(400).json({
      success: false,
      message: 'DigiLocker is not linked. Please initiate DigiLocker verification first.',
    });
    return;
  }
  
  try {
    // FIXED: Decrypt token before using
    const decryptedToken = DigiLocker.decryptSensitiveData(driver.digilockerToken);
    const documents = await DigiLocker.getIssuedDocuments(decryptedToken);
    
    res.json({
      success: true,
      data: {
        documents,
        available_types: documents.map(d => d.type),
      },
    });
  } catch (error: any) {
    logger.error(`[DIGILOCKER] Get documents error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to fetch documents from DigiLocker' });
  }
}));

/**
 * Unlink DigiLocker
 */
app.post('/api/driver/digilocker/unlink', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  
  if (driver.digilockerToken) {
    // FIXED: Decrypt token before revoking (non-blocking)
    const decryptedToken = DigiLocker.decryptSensitiveData(driver.digilockerToken);
    DigiLocker.revokeToken(decryptedToken).catch(() => {});
  }
  
  await prisma.driver.update({
    where: { id: driver.id },
    data: {
      digilockerLinked: false,
      digilockerToken: null,
    },
  });
  
  res.json({
    success: true,
    message: 'DigiLocker unlinked successfully',
  });
}));

// ==================== AADHAAR OTP VERIFICATION ====================

// In-memory OTP store (use Redis in production)
const aadhaarOtpStore = new Map<string, { otp: string; aadhaarNumber: string; expiresAt: Date }>();

/**
 * Request OTP for Aadhaar verification
 * Note: This is a placeholder - actual Aadhaar OTP requires UIDAI API integration
 */
app.post(
  '/api/driver/aadhaar/request-otp',
  authenticate,
  [
    body('aadhaarNumber').matches(/^\d{12}$/).withMessage('Aadhaar must be 12 digits'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { aadhaarNumber } = req.body;
    
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver profile not found' });
      return;
    }
    
    // FIXED: Check rate limit (3 OTP requests per hour)
    const rateLimit = DigiLocker.checkOtpRateLimit(driver.id);
    if (!rateLimit.allowed) {
      res.status(429).json({
        success: false,
        message: `Too many OTP requests. Please try again in ${Math.ceil(rateLimit.retryAfterSeconds! / 60)} minute(s).`,
        data: { retry_after_seconds: rateLimit.retryAfterSeconds },
      });
      return;
    }
    
    // Check if Aadhaar is already verified
    if (driver.aadhaarVerified) {
      res.status(400).json({ success: false, message: 'Aadhaar is already verified' });
      return;
    }
    
    // FIXED: Check for duplicate using masked format (XXXXXXXX + last 4 digits)
    const maskedAadhaar = `XXXXXXXX${aadhaarNumber.slice(-4)}`;
    const existingDriver = await prisma.driver.findFirst({
      where: { aadhaarNumber: maskedAadhaar, id: { not: driver.id } },
    });
    if (existingDriver) {
      res.status(409).json({ success: false, message: 'This Aadhaar number is already registered with another account' });
      return;
    }
    
    // Generate 6-digit OTP
    const otp = process.env.NODE_ENV === 'development' 
      ? '123456' // Fixed OTP for development
      : Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store OTP with masked Aadhaar (expires in 10 minutes)
    // FIXED: Store masked Aadhaar for consistency
    aadhaarOtpStore.set(driver.id, {
      otp,
      aadhaarNumber: maskedAadhaar, // Store masked format
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    
    // In production, send OTP via UIDAI API
    // For now, we'll simulate it
    logger.info(`[AADHAAR] OTP requested for driver ${driver.id}, Aadhaar: XXXX-XXXX-${aadhaarNumber.slice(-4)}`);
    
    // In development, log the OTP
    if (process.env.NODE_ENV === 'development') {
      logger.info(`[AADHAAR] DEV MODE - OTP: ${otp}`);
    }
    
    res.json({
      success: true,
      message: 'OTP sent to Aadhaar-linked mobile number',
      data: {
        aadhaar_masked: `XXXX-XXXX-${aadhaarNumber.slice(-4)}`,
        otp_expires_in: 600, // 10 minutes in seconds
        // Include OTP in dev mode for testing
        ...(process.env.NODE_ENV === 'development' && { dev_otp: otp }),
      },
    });
  })
);

/**
 * Verify Aadhaar OTP
 */
app.post(
  '/api/driver/aadhaar/verify-otp',
  authenticate,
  [
    body('otp').matches(/^\d{6}$/).withMessage('OTP must be 6 digits'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { otp } = req.body;
    
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver profile not found' });
      return;
    }
    
    const storedOtp = aadhaarOtpStore.get(driver.id);
    
    if (!storedOtp) {
      res.status(400).json({ success: false, message: 'No OTP request found. Please request OTP first.' });
      return;
    }
    
    if (storedOtp.expiresAt < new Date()) {
      aadhaarOtpStore.delete(driver.id);
      res.status(400).json({ success: false, message: 'OTP has expired. Please request a new OTP.' });
      return;
    }
    
    if (storedOtp.otp !== otp) {
      res.status(400).json({ success: false, message: 'Invalid OTP' });
      return;
    }
    
    // OTP verified - update driver
    await prisma.driver.update({
      where: { id: driver.id },
      data: {
        aadhaarNumber: storedOtp.aadhaarNumber,
        aadhaarVerified: true,
        aadhaarVerifiedAt: new Date(),
      },
    });
    
    // Clean up OTP
    aadhaarOtpStore.delete(driver.id);
    
    logger.info(`[AADHAAR] Verified for driver ${driver.id}`);
    
    res.json({
      success: true,
      message: 'Aadhaar verified successfully',
      data: {
        aadhaar_verified: true,
        aadhaar_masked: `XXXX-XXXX-${storedOtp.aadhaarNumber.slice(-4)}`,
      },
    });
  })
);

/**
 * Get Aadhaar verification status
 */
app.get('/api/driver/aadhaar/status', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  
  res.json({
    success: true,
    data: {
      aadhaar_number: driver.aadhaarNumber ? `XXXX-XXXX-${driver.aadhaarNumber.slice(-4)}` : null,
      aadhaar_verified: driver.aadhaarVerified,
      aadhaar_verified_at: driver.aadhaarVerifiedAt,
      digilocker_linked: driver.digilockerLinked,
      verification_method: driver.digilockerLinked ? 'digilocker' : (driver.aadhaarVerified ? 'otp' : null),
    },
  });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// DRIVER SUBSCRIPTION (DAILY PLATFORM FEE - ₹39/day)
// ═══════════════════════════════════════════════════════════════════════════════

const DAILY_PLATFORM_FEE = parseFloat(process.env.DAILY_PLATFORM_FEE || '39');
const SUBSCRIPTION_DURATION_HOURS = parseInt(process.env.SUBSCRIPTION_DURATION_HOURS || '24');

/**
 * @openapi
 * /api/driver/subscription/status:
 *   get:
 *     tags: [Subscription]
 *     summary: Get driver subscription status
 *     description: Check if driver has an active subscription and can go online
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Subscription status
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
 *                     allowOnline:
 *                       type: boolean
 *                     validTill:
 *                       type: string
 *                       format: date-time
 *                     status:
 *                       type: string
 *                       enum: [active, expired, never_purchased]
 *                     message:
 *                       type: string
 */
app.get('/api/driver/subscription/status', authenticateDriver, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }

  // Get or create subscription record
  let subscription = await prisma.driverSubscription.findUnique({
    where: { driverId: driver.id },
  });

  if (!subscription) {
    // Create subscription record if it doesn't exist
    subscription = await prisma.driverSubscription.create({
      data: {
        driverId: driver.id,
        isActive: false,
      },
    });
  }

  const now = new Date();
  const isActive = subscription.validTill && subscription.validTill > now;
  
  let status: 'active' | 'expired' | 'never_purchased';
  let message: string;
  
  if (isActive) {
    status = 'active';
    message = 'Your daily pass is active. You can accept rides.';
  } else if (subscription.lastPaidAt) {
    status = 'expired';
    message = 'Your daily pass has expired. Pay ₹39 to continue.';
  } else {
    status = 'never_purchased';
    message = 'Pay ₹39 to start taking rides today.';
  }

  logger.info(`[SUBSCRIPTION] Status check for driver ${driver.id}: ${status}, validTill: ${subscription.validTill}`);

  res.json({
    success: true,
    data: {
      driverId: driver.id,
      allowOnline: isActive,
      isActive,
      validTill: subscription.validTill?.toISOString() ?? null,
      lastPaidAt: subscription.lastPaidAt?.toISOString() ?? null,
      status,
      message,
      fee: DAILY_PLATFORM_FEE,
      durationHours: SUBSCRIPTION_DURATION_HOURS,
    },
  });
}));

/**
 * @openapi
 * /api/driver/subscription/activate:
 *   post:
 *     tags: [Subscription]
 *     summary: Activate driver subscription after payment
 *     description: Call this after driver completes UPI payment to activate 24-hour subscription
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               transactionId:
 *                 type: string
 *                 description: UPI transaction ID (optional, for verification)
 *               paymentMethod:
 *                 type: string
 *                 default: UPI
 *     responses:
 *       200:
 *         description: Subscription activated
 *       400:
 *         description: Activation failed
 */
app.post(
  '/api/driver/subscription/activate',
  authenticateDriver,
  [
    body('transactionId').optional().isString().trim(),
    body('paymentMethod').optional().isString().default('UPI'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const { transactionId, paymentMethod = 'UPI' } = req.body;
    const now = new Date();
    const validTill = new Date(now.getTime() + SUBSCRIPTION_DURATION_HOURS * 60 * 60 * 1000);

    // Get or create subscription
    let subscription = await prisma.driverSubscription.findUnique({
      where: { driverId: driver.id },
    });

    if (!subscription) {
      subscription = await prisma.driverSubscription.create({
        data: {
          driverId: driver.id,
          isActive: false,
        },
      });
    }

    // Update subscription
    const updatedSubscription = await prisma.driverSubscription.update({
      where: { id: subscription.id },
      data: {
        lastPaidAt: now,
        validTill,
        isActive: true,
        totalPayments: { increment: 1 },
        totalAmount: { increment: DAILY_PLATFORM_FEE },
      },
    });

    // Create payment record
    await prisma.driverSubscriptionPayment.create({
      data: {
        subscriptionId: subscription.id,
        driverId: driver.id,
        amount: DAILY_PLATFORM_FEE,
        paymentMethod,
        transactionId: transactionId || null,
        status: 'VERIFIED', // In production, this should be PENDING until verified
        validFrom: now,
        validTill,
        verifiedAt: now,
      },
    });

    logger.info(`[SUBSCRIPTION] Activated for driver ${driver.id}, validTill: ${validTill.toISOString()}, txnId: ${transactionId || 'N/A'}`);

    res.json({
      success: true,
      message: 'Subscription activated successfully! You can now go online.',
      data: {
        driverId: driver.id,
        validTill: validTill.toISOString(),
        validFrom: now.toISOString(),
        durationHours: SUBSCRIPTION_DURATION_HOURS,
        amountPaid: DAILY_PLATFORM_FEE,
        transactionId: transactionId || null,
      },
    });
  })
);

/**
 * @openapi
 * /api/driver/subscription/history:
 *   get:
 *     tags: [Subscription]
 *     summary: Get subscription payment history
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
 *     responses:
 *       200:
 *         description: Payment history
 */
app.get(
  '/api/driver/subscription/history',
  authenticateDriver,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 50 }),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }

    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const [payments, total] = await Promise.all([
      prisma.driverSubscriptionPayment.findMany({
        where: { driverId: driver.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.driverSubscriptionPayment.count({ where: { driverId: driver.id } }),
    ]);

    res.json({
      success: true,
      data: {
        payments: payments.map((p) => ({
          id: p.id,
          amount: p.amount,
          paymentMethod: p.paymentMethod,
          transactionId: p.transactionId,
          status: p.status,
          validFrom: p.validFrom.toISOString(),
          validTill: p.validTill.toISOString(),
          createdAt: p.createdAt.toISOString(),
        })),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasNext: page < Math.ceil(total / limit),
          hasPrev: page > 1,
        },
      },
    });
  })
);

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  
  // Start document verification worker if Redis is available
  if (isQueueAvailable()) {
    startVerificationWorker();
    logger.info('[WORKER] Document verification worker started');
  } else {
    logger.warn('[WORKER] Redis not available, document verification worker not started');
  }
  
  app.listen(PORT, () => logger.info(`Driver service running on port ${PORT}`));
};

const shutdown = async () => {
  logger.info('Shutting down driver service...');
  await stopVerificationWorker();
  await closeQueues();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch((err) => {
  logger.error('Failed to start driver-service', { error: err });
  process.exit(1);
});
