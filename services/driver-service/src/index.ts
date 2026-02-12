import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, authenticate, authenticateDriver, AuthRequest } from '@raahi/shared';
import { errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger, latLngToH3 } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import { OnboardingStatus, PenaltyStatus } from '@prisma/client';
import * as DigiLocker from './digilocker';

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

const uploadDir = path.join(process.cwd(), 'uploads', 'driver-documents');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, file.fieldname + '-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|pdf/;
    if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only .png, .jpg, .jpeg and .pdf allowed'));
  },
});

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(uploadDir));

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'driver-service', timestamp: new Date().toISOString() });
});

// Driver profile & status
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
      onboarding: { status: driver.onboardingStatus, is_verified: driver.isVerified, documents_submitted: driver.documentsSubmittedAt != null, documents_verified: allDocsVerified, can_start_rides: driver.isVerified && allDocsVerified, verification_notes: driver.verificationNotes },
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

// List driver penalties (optional filter: ?status=PENDING)
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

// Pay unpaid penalties so driver can go online again
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

// GET /api/driver/earnings - Summary with real calculations
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

// GET /api/driver/earnings/transactions - List individual earning records
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
  })
);

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

// POST /api/driver/support - Submit support ticket (persisted to DB)
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

// GET /api/driver/support - List driver's support tickets
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

// GET /api/driver/support/:id - Get single support ticket
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
// GET /api/driver/settings - Get driver settings
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

// PUT /api/driver/settings - Update driver settings
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
 * Step 1: Start onboarding - creates driver profile
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

app.post('/api/driver/onboarding/document/upload', authenticate, upload.single('document'), asyncHandler(async (req: AuthRequest, res) => {
  if (!req.file) {
    res.status(400).json({ success: false, message: 'No file uploaded' });
    return;
  }
  if (!req.body.documentType) {
    res.status(400).json({ success: false, message: 'Document type is required' });
    return;
  }
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  const document = await prisma.driverDocument.create({
    data: {
      driverId: driver.id,
      documentType: req.body.documentType.toUpperCase(),
      documentUrl: `/uploads/driver-documents/${req.file.filename}`,
      documentName: req.file.originalname,
      documentSize: req.file.size,
    },
  });
  let newStatus = driver.onboardingStatus;
  if (req.body.documentType === 'LICENSE') newStatus = OnboardingStatus.PROFILE_PHOTO;
  else if (req.body.documentType === 'PROFILE_PHOTO') newStatus = OnboardingStatus.PHOTO_CONFIRMATION;
  await prisma.driver.update({ where: { id: driver.id }, data: { onboardingStatus: newStatus } });
  res.status(201).json({ success: true, message: 'Document uploaded successfully', data: { document_id: document.id, document_type: document.documentType, document_url: document.documentUrl, uploaded_at: document.uploadedAt, next_step: newStatus } });
}));

app.post('/api/driver/onboarding/documents/submit', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id }, include: { documents: true } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  const required = ['LICENSE', 'PAN_CARD', 'RC', 'AADHAAR_CARD', 'PROFILE_PHOTO'];
  const uploaded = driver.documents.map((d) => d.documentType);
  const missing = required.filter((r) => !uploaded.includes(r as any));
  if (missing.length > 0) {
    res.status(400).json({ success: false, message: 'Missing required documents', data: { missing_documents: missing } });
    return;
  }
  await prisma.driver.update({ where: { id: driver.id }, data: { onboardingStatus: OnboardingStatus.DOCUMENT_VERIFICATION, documentsSubmittedAt: new Date() } });
  res.json({ success: true, message: 'Documents submitted for verification', data: { driver_id: driver.id, status: 'DOCUMENT_VERIFICATION', submitted_at: new Date(), estimated_verification_time: '24-48 hours' } });
}));

/**
 * Get onboarding status with detailed verification info
 */
app.get('/api/driver/onboarding/status', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findFirst({ where: { userId: req.user!.id }, include: { documents: true, user: true } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver profile not found' });
    return;
  }
  
  const allDocsVerified = driver.documents.length > 0 && driver.documents.every((d) => d.isVerified);
  const pendingDocs = driver.documents.filter((d) => !d.isVerified);
  const verifiedDocs = driver.documents.filter((d) => d.isVerified);
  
  // Calculate verification progress percentage
  const requiredDocs = ['LICENSE', 'RC', 'INSURANCE', 'PAN_CARD', 'AADHAAR_CARD', 'PROFILE_PHOTO'];
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
          uploaded_at: d.uploadedAt,
          rejection_reason: d.rejectionReason,
        })),
        details: driver.documents.map(d => ({
          type: d.documentType,
          uploaded_at: d.uploadedAt,
          is_verified: d.isVerified,
          verified_at: d.verifiedAt,
          rejection_reason: d.rejectionReason,
        })),
      },
      
      // Overall status
      documents_submitted: driver.documentsSubmittedAt != null,
      documents_submitted_at: driver.documentsSubmittedAt,
      documents_verified: allDocsVerified,
      documents_verified_at: driver.documentsVerifiedAt,
      verification_progress: verificationProgress,
      can_start_rides: driver.isVerified && allDocsVerified,
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

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(PORT, () => logger.info(`Driver service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start driver-service', { error: err });
  process.exit(1);
});
