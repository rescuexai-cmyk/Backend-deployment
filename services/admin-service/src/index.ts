import express, { NextFunction, Response } from 'express';
import cors from 'cors';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, authenticate, AuthRequest } from '@raahi/shared';
import { errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import { OnboardingStatus } from '@prisma/client';

const logger = createLogger('admin-service');
const app = express();
const PORT = process.env.PORT || 5008;

// ==================== PAGINATION LIMITS ====================
const MAX_PAGINATION_LIMIT = 100;
const DEFAULT_PAGINATION_LIMIT = 50;

function sanitizePagination(
  limitStr: string | undefined,
  offsetStr: string | undefined
): { limit: number; offset: number } {
  const limit = Math.min(
    MAX_PAGINATION_LIMIT,
    Math.max(1, parseInt(limitStr || String(DEFAULT_PAGINATION_LIMIT)) || DEFAULT_PAGINATION_LIMIT)
  );
  const offset = Math.max(0, parseInt(offsetStr || '0') || 0);
  return { limit, offset };
}

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'admin-service', timestamp: new Date().toISOString() });
});

// Admin role check middleware
// In production, this should check against an admin users table or role field
const requireAdmin = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  // For now, we check if user exists - in production, add proper admin role check
  // TODO: Add proper admin role field to User model or create Admin model
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }
  
  // In development, allow any authenticated user to access admin endpoints
  // In production, this should check req.user.role === 'admin' or similar
  if (process.env.NODE_ENV === 'production') {
    // Check if user email ends with @raahi.com or is in admin list
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
    const userEmail = req.user.email?.toLowerCase();
    
    if (!userEmail || !adminEmails.includes(userEmail)) {
      logger.warn(`Non-admin user attempted to access admin endpoint`, { 
        userId: req.user.id, 
        email: req.user.email 
      });
      res.status(403).json({ success: false, message: 'Admin access required' });
      return;
    }
  }
  
  next();
});

function formatDriver(driver: any) {
  const allDocsVerified = driver.documents.length > 0 && driver.documents.every((d: any) => d.isVerified);
  const pendingDocs = driver.documents.filter((d: any) => !d.isVerified);
  const rejectedDocs = driver.documents.filter((d: any) => d.rejectionReason);
  return {
    driver_id: driver.id,
    user: { id: driver.user.id, name: `${driver.user.firstName} ${driver.user.lastName}`, email: driver.user.email, phone: driver.user.phone, created_at: driver.user.createdAt },
    onboarding_status: driver.onboardingStatus,
    vehicle_info: { type: driver.vehicleType, model: driver.vehicleModel, number: driver.vehicleNumber, color: driver.vehicleColor, year: driver.vehicleYear },
    documents: driver.documents.map((d: any) => ({ id: d.id, type: d.documentType, url: d.documentUrl, name: d.documentName, size: d.documentSize, is_verified: d.isVerified, verified_at: d.verifiedAt, verified_by: d.verifiedBy, rejection_reason: d.rejectionReason, uploaded_at: d.uploadedAt })),
    documents_summary: { total: driver.documents.length, verified: driver.documents.filter((d: any) => d.isVerified).length, pending: pendingDocs.length, rejected: rejectedDocs.length, all_verified: allDocsVerified },
    submitted_at: driver.documentsSubmittedAt,
    verified_at: driver.documentsVerifiedAt,
    preferred_language: driver.preferredLanguage,
    service_types: driver.serviceTypes,
    verification_notes: driver.verificationNotes,
    is_verified: driver.isVerified,
    is_online: driver.isOnline,
    rating: driver.rating,
    total_trips: driver.totalRides,
  };
}

app.get(
  '/api/admin/drivers',
  authenticate,
  requireAdmin,
  [
    query('limit').optional().isInt({ min: 1, max: MAX_PAGINATION_LIMIT }).withMessage(`limit must be between 1 and ${MAX_PAGINATION_LIMIT}`),
    query('offset').optional().isInt({ min: 0 }).withMessage('offset must be a non-negative integer'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { status, search, filter = 'all' } = req.query;
    const { limit, offset } = sanitizePagination(req.query.limit as string, req.query.offset as string);
    
    const whereClause: any = {};
    if (filter === 'pending') {
      whereClause.AND = [{ isVerified: false }, { OR: [{ documents: { some: { isVerified: false } } }, { documents: { none: {} } }] }];
    } else if (filter === 'verified') whereClause.isVerified = true;
    else if (filter === 'rejected') whereClause.onboardingStatus = OnboardingStatus.REJECTED;
    if (search && typeof search === 'string') {
      whereClause.OR = [
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { phone: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status && typeof status === 'string' && filter !== 'rejected') {
      if (whereClause.AND) whereClause.AND.push({ onboardingStatus: status });
      else whereClause.onboardingStatus = status;
    }
    const queryWhere = Object.keys(whereClause).length > 0 ? whereClause : undefined;
    const drivers = await prisma.driver.findMany({
      where: queryWhere,
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, createdAt: true } }, documents: { orderBy: { uploadedAt: 'desc' } } },
      orderBy: { joinedAt: 'desc' },
      take: limit,
      skip: offset,
    });
    const totalCount = await prisma.driver.count({ where: queryWhere });
    res.json({ success: true, data: { drivers: drivers.map(formatDriver), pagination: { total: totalCount, limit, offset, has_more: offset + limit < totalCount } } });
  })
);

app.get(
  '/api/admin/drivers/pending',
  authenticate,
  requireAdmin,
  [
    query('limit').optional().isInt({ min: 1, max: MAX_PAGINATION_LIMIT }).withMessage(`limit must be between 1 and ${MAX_PAGINATION_LIMIT}`),
    query('offset').optional().isInt({ min: 0 }).withMessage('offset must be a non-negative integer'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const { status, search } = req.query;
    const { limit, offset } = sanitizePagination(req.query.limit as string, req.query.offset as string);
    
    const whereClause: any = { documents: { some: { isVerified: false } }, isVerified: false };
    if (search && typeof search === 'string') {
      whereClause.OR = [
        { user: { firstName: { contains: search, mode: 'insensitive' } } },
        { user: { lastName: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { user: { phone: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (status && typeof status === 'string') whereClause.onboardingStatus = status;
    const drivers = await prisma.driver.findMany({
      where: whereClause,
      include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, createdAt: true } }, documents: { orderBy: { uploadedAt: 'desc' } } },
      orderBy: { documentsSubmittedAt: 'desc' },
      take: limit,
      skip: offset,
    });
    const totalCount = await prisma.driver.count({ where: whereClause });
    res.json({ success: true, data: { drivers: drivers.map(formatDriver), pagination: { total: totalCount, limit, offset, has_more: offset + limit < totalCount } } });
  })
);

app.get('/api/admin/drivers/:driverId', authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res) => {
  const driver = await prisma.driver.findUnique({
    where: { id: req.params.driverId },
    include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, createdAt: true } }, documents: { orderBy: { uploadedAt: 'desc' } } },
  });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }
  const allDocsVerified = driver.documents.length > 0 && driver.documents.every((d) => d.isVerified);
  res.json({
    success: true,
    data: {
      ...formatDriver(driver),
      vehicle_info: { ...(formatDriver(driver).vehicle_info as object), license_number: driver.licenseNumber, license_expiry: driver.licenseExpiry },
      documents_verified: allDocsVerified,
      current_latitude: driver.currentLatitude,
      current_longitude: driver.currentLongitude,
    },
  });
}));

app.post('/api/admin/documents/:documentId/verify', authenticate, requireAdmin, [body('approved').isBoolean(), body('rejection_reason').optional().isString()], asyncHandler(async (req: AuthRequest, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, errors: errors.array() });
    return;
  }
  const { documentId } = req.params;
  const { approved, rejection_reason } = req.body;
  const document = await prisma.driverDocument.findUnique({ where: { id: documentId }, include: { driver: true } });
  if (!document) {
    res.status(404).json({ success: false, message: 'Document not found' });
    return;
  }
  await prisma.driverDocument.update({
    where: { id: documentId },
    data: { isVerified: approved, verifiedAt: approved ? new Date() : null, verifiedBy: req.user!.id, rejectionReason: approved ? null : rejection_reason },
  });
  const allDriverDocuments = await prisma.driverDocument.findMany({ where: { driverId: document.driverId } });
  const allDocsVerified = allDriverDocuments.length > 0 && allDriverDocuments.every((d) => d.isVerified);
  const hasRejectedDocs = allDriverDocuments.some((d) => d.rejectionReason);
  let newOnboardingStatus = document.driver.onboardingStatus;
  let isVerified = document.driver.isVerified;
  let verificationNotes = document.driver.verificationNotes;
  if (allDocsVerified) {
    newOnboardingStatus = OnboardingStatus.COMPLETED;
    isVerified = true;
    verificationNotes = 'All documents verified. You can now start accepting rides!';
  } else if (hasRejectedDocs) {
    newOnboardingStatus = OnboardingStatus.REJECTED;
    isVerified = false;
    verificationNotes = 'Some documents were rejected. Please re-upload the rejected documents.';
  }
  await prisma.driver.update({
    where: { id: document.driverId },
    data: { onboardingStatus: newOnboardingStatus, isVerified, documentsVerifiedAt: allDocsVerified ? new Date() : null, verificationNotes },
  });
  res.json({
    success: true,
    message: approved ? 'Document approved successfully' : 'Document rejected',
    data: { document_id: documentId, document_type: document.documentType, is_verified: approved, driver_status: { all_documents_verified: allDocsVerified, onboarding_status: newOnboardingStatus, is_verified: isVerified, can_start_rides: isVerified && allDocsVerified } },
  });
}));

app.post('/api/admin/drivers/:driverId/verify-all', authenticate, requireAdmin, [body('approved').isBoolean(), body('notes').optional().isString()], asyncHandler(async (req: AuthRequest, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, errors: errors.array() });
    return;
  }
  const { driverId } = req.params;
  const { approved, notes } = req.body;
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, include: { documents: true } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }
  await prisma.driverDocument.updateMany({
    where: { driverId },
    data: { isVerified: approved, verifiedAt: approved ? new Date() : null, verifiedBy: req.user!.id, rejectionReason: approved ? null : 'Rejected by admin' },
  });
  const newStatus = approved ? OnboardingStatus.COMPLETED : OnboardingStatus.REJECTED;
  const verificationNotes = notes || (approved ? 'All documents verified. You can now start accepting rides!' : 'Documents verification failed. Please re-upload valid documents.');
  await prisma.driver.update({
    where: { id: driverId },
    data: { onboardingStatus: newStatus, isVerified: approved, documentsVerifiedAt: approved ? new Date() : null, verificationNotes },
  });
  res.json({ success: true, message: approved ? 'All documents approved successfully' : 'All documents rejected', data: { driver_id: driverId, documents_updated: driver.documents.length, onboarding_status: newStatus, is_verified: approved, can_start_rides: approved, verification_notes: verificationNotes } });
}));

app.get('/api/admin/statistics', authenticate, requireAdmin, asyncHandler(async (req: AuthRequest, res) => {
  const [totalDrivers, verifiedDrivers, pendingVerification, rejectedDrivers, totalDocuments, pendingDocuments, verifiedDocuments] = await Promise.all([
    prisma.driver.count(),
    prisma.driver.count({ where: { isVerified: true } }),
    prisma.driver.count({
      where: {
        isVerified: false,
        OR: [{ documents: { some: { isVerified: false } } }, { documents: { none: {} } }],
      },
    }),
    prisma.driver.count({ where: { onboardingStatus: OnboardingStatus.REJECTED } }),
    prisma.driverDocument.count(),
    prisma.driverDocument.count({ where: { isVerified: false, rejectionReason: null } }),
    prisma.driverDocument.count({ where: { isVerified: true } }),
  ]);
  res.json({
    success: true,
    data: {
      drivers: { total: totalDrivers, verified: verifiedDrivers, pending_verification: pendingVerification, rejected: rejectedDrivers },
      documents: { total: totalDocuments, verified: verifiedDocuments, pending: pendingDocuments },
    },
  });
}));

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(PORT, () => logger.info(`Admin service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start admin-service', { error: err });
  process.exit(1);
});
