import path from 'path';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import express, { NextFunction, Response } from 'express';
import cors from 'cors';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, authenticate, AuthRequest, setupSwagger } from '@raahi/shared';
import { errorHandler, notFound, asyncHandler } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { prisma } from '@raahi/shared';
import { canDriverStartRides, REQUIRED_DOCUMENTS, COMPLETED_ONBOARDING_STATUS, checkRequiredDocuments } from '@raahi/shared';
import { bannerUploadMiddleware, uploadBannerImage } from './bannerUpload';
import { presignDocumentUrl, notifyDriverVerification } from './driverDocs';
import { OnboardingStatus } from '@prisma/client';

const logger = createLogger('admin-service');
const app = express();
const PORT = process.env.PORT || 5008;

const PRICING_SERVICE_URL = process.env.PRICING_SERVICE_URL || 'http://localhost:5005';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:5002';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Separate credentials for the driver verification dashboard so the marketing
// team (ADMIN_EMAIL) cannot access the document review flow.
const VERIFIER_EMAIL = (process.env.VERIFIER_EMAIL || '').trim().toLowerCase();
const VERIFIER_PASSWORD = process.env.VERIFIER_PASSWORD || '';

type DashboardRole = 'marketing' | 'verifier';

function verifyAdminPassword(input: string, expected: string): boolean {
  if (!expected) return false;
  const inputHash = crypto.createHash('sha256').update(input).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(inputHash, expectedHash);
}

function signAdminToken(email: string, role: DashboardRole): string {
  const jwtSecret = process.env.JWT_SECRET || 'fallback-secret-key';
  const jwtAny = jwt as any;
  return jwtAny.sign({ type: 'admin', email, role }, jwtSecret, { expiresIn: '7d' });
}

/**
 * Forward a promo-management request to the pricing-service admin API using the
 * internal key. Keeps the internal key server-side (never in the browser) and
 * reuses the pricing-service's validation + cache invalidation.
 */
async function pricingProxy(
  method: string,
  proxyPath: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const doFetch = (globalThis as any).fetch as (url: string, init?: any) => Promise<any>;
  const resp = await doFetch(`${PRICING_SERVICE_URL}${proxyPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-internal-api-key': INTERNAL_API_KEY },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

async function userProxy(
  method: string,
  proxyPath: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const doFetch = (globalThis as any).fetch as (url: string, init?: any) => Promise<any>;
  const resp = await doFetch(`${USER_SERVICE_URL}${proxyPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-internal-api-key': INTERNAL_API_KEY },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

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

// Setup Swagger documentation
setupSwagger(app, {
  title: 'Admin Service API',
  version: '1.0.0',
  description: 'Raahi Admin Service - Driver verification and platform management',
  port: Number(PORT),
  basePath: '/api/admin',
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
  res.json({ status: 'OK', service: 'admin-service', timestamp: new Date().toISOString() });
});

/**
 * @openapi
 * /api/admin/login:
 *   post:
 *     tags: [Auth]
 *     summary: Admin dashboard login (email + password)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200: { description: JWT access token }
 *       401: { description: Invalid credentials }
 */
app.post(
  '/api/admin/login',
  [body('email').isEmail().normalizeEmail(), body('password').isString().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Valid email and password required', errors: errors.array() });
      return;
    }

    if (!ADMIN_EMAIL && !VERIFIER_EMAIL) {
      logger.error('[ADMIN] No dashboard credentials configured (ADMIN_EMAIL / VERIFIER_EMAIL)');
      res.status(503).json({ success: false, message: 'Admin login not configured' });
      return;
    }

    const email = String(req.body.email).trim().toLowerCase();
    const password = String(req.body.password);

    let role: DashboardRole | null = null;
    if (ADMIN_EMAIL && ADMIN_PASSWORD && email === ADMIN_EMAIL && verifyAdminPassword(password, ADMIN_PASSWORD)) {
      role = 'marketing';
    } else if (VERIFIER_EMAIL && VERIFIER_PASSWORD && email === VERIFIER_EMAIL && verifyAdminPassword(password, VERIFIER_PASSWORD)) {
      role = 'verifier';
    }

    if (!role) {
      logger.warn('[ADMIN] Failed login attempt', { email });
      res.status(401).json({ success: false, message: 'Invalid email or password' });
      return;
    }

    const accessToken = signAdminToken(email, role);
    logger.info('[ADMIN] Dashboard login', { email, role });
    res.json({
      success: true,
      data: {
        accessToken,
        expiresIn: 7 * 24 * 60 * 60,
        email,
        role,
      },
    });
  }),
);

// Role-based dashboard access control.
// Dashboard logins carry a role in their JWT ('marketing' or 'verifier');
// each route family only accepts its own role, so the marketing account
// cannot touch driver verification APIs and vice versa.
// Legacy ADMIN_EMAILS allow-list app users keep full access (ops/superadmin).
const requireRole = (...allowedRoles: DashboardRole[]) =>
  asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Authentication required' });
      return;
    }

    // In development, allow any authenticated user to access admin endpoints
    if (process.env.NODE_ENV === 'production') {
      const userEmail = req.user.email?.toLowerCase();

      // Dashboard account (env-configured email/password login)
      if (req.user.id === 'admin') {
        const role = req.user.adminRole as DashboardRole | undefined;
        if (role && allowedRoles.includes(role)) {
          next();
          return;
        }
        logger.warn('[ADMIN] Dashboard account attempted to access endpoint outside its role', {
          email: userEmail,
          role,
          required: allowedRoles,
        });
        res.status(403).json({ success: false, message: 'Your account does not have access to this section' });
        return;
      }

      // Legacy allow-list for app users with JWT — full access
      const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

      if (!userEmail || !adminEmails.includes(userEmail)) {
        logger.warn(`Non-admin user attempted to access admin endpoint`, {
          userId: req.user.id,
          email: req.user.email,
        });
        res.status(403).json({ success: false, message: 'Admin access required' });
        return;
      }
    }

    next();
  });

// Marketing dashboard routes (promos, banners)
const requireAdmin = requireRole('marketing');
// Driver verification dashboard routes (drivers, documents)
const requireVerifier = requireRole('verifier');

function formatDriver(driver: any) {
  const allDocsVerified = driver.documents.length > 0 && driver.documents.every((d: any) => d.isVerified);
  const pendingDocs = driver.documents.filter((d: any) => !d.isVerified);
  const rejectedDocs = driver.documents.filter((d: any) => d.rejectionReason);
  return {
    driver_id: driver.id,
    user: { id: driver.user.id, name: `${driver.user.firstName} ${driver.user.lastName}`, email: driver.user.email, phone: driver.user.phone, created_at: driver.user.createdAt },
    onboarding_status: driver.onboardingStatus,
    vehicle_info: { type: driver.vehicleType, model: driver.vehicleModel, number: driver.vehicleNumber, color: driver.vehicleColor, year: driver.vehicleYear },
    documents: driver.documents.map((d: any) => ({ id: d.id, type: d.documentType, url: d.documentUrl, name: d.documentName, size: d.documentSize, is_verified: d.isVerified, verified_at: d.verifiedAt, verified_by: d.verifiedBy, rejection_reason: d.rejectionReason, uploaded_at: d.uploadedAt, verification_status: d.verificationStatus, ai_verified: d.aiVerified, ai_confidence: d.aiConfidence, ai_mismatch_reason: d.aiMismatchReason, ai_verified_at: d.aiVerifiedAt })),
    documents_summary: { total: driver.documents.length, verified: driver.documents.filter((d: any) => d.isVerified).length, pending: pendingDocs.length, rejected: rejectedDocs.length, all_verified: allDocsVerified, required: [...REQUIRED_DOCUMENTS] },
    submitted_at: driver.documentsSubmittedAt,
    verified_at: driver.documentsVerifiedAt,
    preferred_language: driver.preferredLanguage,
    service_types: driver.serviceTypes,
    verification_notes: driver.verificationNotes,
    is_verified: driver.isVerified,
    is_active: driver.isActive,
    is_online: driver.isOnline,
    can_start_rides: canDriverStartRides(driver),
    rating: driver.rating,
    total_trips: driver.totalRides,
  };
}

/**
 * @openapi
 * /api/admin/drivers:
 *   get:
 *     tags: [Drivers]
 *     summary: List all drivers
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           maximum: 100
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *           enum: [all, pending, verified, rejected]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of drivers
 *       403:
 *         description: Admin access required
 */
app.get(
  '/api/admin/drivers',
  authenticate,
  requireVerifier,
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
  requireVerifier,
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

app.get('/api/admin/drivers/:driverId', authenticate, requireVerifier, asyncHandler(async (req: AuthRequest, res) => {
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

/**
 * GET /api/admin/documents/review-queue
 *
 * Document review list with presigned URLs so admins can view the actual
 * uploads in the browser.
 *
 * status:
 *   - "all" (default): documents needing manual review (flagged/failed/pending/processing)
 *   - "verified": documents already verified (by AI or admin)
 *   - "everything": every uploaded document regardless of status
 *   - or a single raw status (flagged/failed/pending/processing)
 * search: filters by driver name, phone, or email.
 */
app.get(
  '/api/admin/documents/review-queue',
  authenticate,
  requireVerifier,
  [
    query('status').optional().isIn(['flagged', 'failed', 'pending', 'processing', 'verified', 'everything', 'all']),
    query('search').optional().isString().isLength({ max: 100 }),
    query('limit').optional().isInt({ min: 1, max: MAX_PAGINATION_LIMIT }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }
    const { limit, offset } = sanitizePagination(req.query.limit as string, req.query.offset as string);
    const statusFilter = (req.query.status as string) || 'all';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const where: any = {};
    if (statusFilter === 'all') {
      where.isVerified = false;
      where.verificationStatus = { in: ['flagged', 'failed', 'pending', 'processing'] };
    } else if (statusFilter === 'verified') {
      where.OR = [{ isVerified: true }, { verificationStatus: 'verified' }];
    } else if (statusFilter !== 'everything') {
      where.isVerified = false;
      where.verificationStatus = { in: [statusFilter] };
    }
    if (search) {
      where.driver = {
        user: {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
          ],
        },
      };
    }

    const [docs, totalCount] = await Promise.all([
      prisma.driverDocument.findMany({
        where,
        include: {
          driver: {
            include: { user: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } } },
          },
        },
        // Keep each driver's documents together so the dashboard can group them.
        orderBy: [{ driverId: 'asc' }, { uploadedAt: 'asc' }],
        take: limit,
        skip: offset,
      }),
      prisma.driverDocument.count({ where }),
    ]);

    const documents = await Promise.all(
      docs.map(async (d) => ({
        id: d.id,
        document_type: d.documentType,
        document_name: d.documentName,
        uploaded_at: d.uploadedAt,
        verification_status: d.verificationStatus,
        is_verified: d.isVerified,
        verified_by: d.verifiedBy,
        verified_at: d.verifiedAt,
        ai_verified: d.aiVerified,
        ai_confidence: d.aiConfidence,
        ai_mismatch_reason: d.aiMismatchReason,
        ai_extracted_data: d.aiExtractedData,
        rejection_reason: d.rejectionReason,
        view_url: await presignDocumentUrl(d.documentUrl),
        driver: {
          id: d.driver.id,
          name: `${d.driver.user.firstName} ${d.driver.user.lastName || ''}`.trim(),
          email: d.driver.user.email,
          phone: d.driver.user.phone,
          vehicle_type: d.driver.vehicleType,
          vehicle_number: d.driver.vehicleNumber,
          onboarding_status: d.driver.onboardingStatus,
          verification_notes: d.driver.verificationNotes,
        },
      })),
    );

    res.json({
      success: true,
      data: { documents, pagination: { total: totalCount, limit, offset, has_more: offset + limit < totalCount } },
    });
  }),
);

/**
 * GET /api/admin/documents/:documentId/view-url
 * Fresh presigned URL for viewing a single document (e.g. after the queue's
 * URL expired).
 */
app.get('/api/admin/documents/:documentId/view-url', authenticate, requireVerifier, asyncHandler(async (req: AuthRequest, res) => {
  const document = await prisma.driverDocument.findUnique({ where: { id: req.params.documentId } });
  if (!document) {
    res.status(404).json({ success: false, message: 'Document not found' });
    return;
  }
  const url = await presignDocumentUrl(document.documentUrl);
  if (!url) {
    res.status(502).json({ success: false, message: 'Could not generate view URL (S3 not configured?)' });
    return;
  }
  res.json({ success: true, data: { url, expires_in: 3600 } });
}));

app.post('/api/admin/documents/:documentId/verify', authenticate, requireVerifier, [body('approved').isBoolean(), body('rejection_reason').optional().isString()], asyncHandler(async (req: AuthRequest, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, errors: errors.array() });
    return;
  }
  const { documentId } = req.params;
  const { approved, rejection_reason } = req.body;
  const document = await prisma.driverDocument.findUnique({
    where: { id: documentId },
    include: { driver: { include: { user: { select: { id: true, firstName: true } } } } },
  });
  if (!document) {
    res.status(404).json({ success: false, message: 'Document not found' });
    return;
  }
  await prisma.driverDocument.update({
    where: { id: documentId },
    data: {
      isVerified: approved,
      verifiedAt: approved ? new Date() : null,
      verifiedBy: 'ADMIN',
      rejectionReason: approved ? null : rejection_reason || 'Rejected by admin',
      verificationStatus: approved ? 'verified' : 'failed',
    },
  });
  const allDriverDocuments = await prisma.driverDocument.findMany({ where: { driverId: document.driverId } });
  const docCheck = checkRequiredDocuments(allDriverDocuments.map((d) => d.documentType), document.driver.vehicleType);
  const allDocsVerified = docCheck.isComplete && allDriverDocuments.length > 0 && allDriverDocuments.every((d) => d.isVerified);
  const hasRejectedDocs = allDriverDocuments.some((d) => !d.isVerified && d.rejectionReason);
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
    data: {
      onboardingStatus: newOnboardingStatus,
      isVerified,
      ...(allDocsVerified ? { isActive: true, documentsVerifiedAt: new Date() } : { documentsVerifiedAt: null }),
      verificationNotes,
    },
  });

  logger.info(`[ADMIN] Document ${documentId} (${document.documentType}) ${approved ? 'approved' : 'rejected'} for driver ${document.driverId}`);

  // Realtime reflection in the driver app (push + in-app notification).
  const docLabel = String(document.documentType).replace(/_/g, ' ').toLowerCase();
  if (allDocsVerified) {
    void notifyDriverVerification({
      userId: document.driver.user.id,
      event: 'VERIFIED',
      title: 'You are verified! 🎉',
      message: 'All your documents have been approved. You can now go online and start accepting rides.',
      onboardingStatus: 'COMPLETED',
    });
  } else if (approved) {
    void notifyDriverVerification({
      userId: document.driver.user.id,
      event: 'DOCUMENT_APPROVED',
      title: 'Document approved',
      message: `Your ${docLabel} has been approved.`,
      documentType: document.documentType,
      onboardingStatus: String(newOnboardingStatus),
    });
  } else {
    void notifyDriverVerification({
      userId: document.driver.user.id,
      event: 'DOCUMENT_REJECTED',
      title: 'Document needs attention',
      message: `Your ${docLabel} was rejected${rejection_reason ? `: ${rejection_reason}` : ''}. Please re-upload it in the app.`,
      documentType: document.documentType,
      onboardingStatus: String(newOnboardingStatus),
    });
  }

  res.json({
    success: true,
    message: approved ? 'Document approved successfully' : 'Document rejected',
    data: { document_id: documentId, document_type: document.documentType, is_verified: approved, driver_status: { all_documents_verified: allDocsVerified, onboarding_status: newOnboardingStatus, is_verified: isVerified, can_start_rides: isVerified && allDocsVerified } },
  });
}));

app.post('/api/admin/drivers/:driverId/verify-all', authenticate, requireVerifier, [body('approved').isBoolean(), body('notes').optional().isString()], asyncHandler(async (req: AuthRequest, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ success: false, errors: errors.array() });
    return;
  }
  const { driverId } = req.params;
  const { approved, notes } = req.body;
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, include: { documents: true, user: { select: { id: true } } } });
  if (!driver) {
    res.status(404).json({ success: false, message: 'Driver not found' });
    return;
  }
  await prisma.driverDocument.updateMany({
    where: { driverId },
    data: { isVerified: approved, verifiedAt: approved ? new Date() : null, verifiedBy: 'ADMIN', rejectionReason: approved ? null : 'Rejected by admin', verificationStatus: approved ? 'verified' : 'failed' },
  });
  const newStatus = approved ? OnboardingStatus.COMPLETED : OnboardingStatus.REJECTED;
  const verificationNotes = notes || (approved ? 'All documents verified. You can now start accepting rides!' : 'Documents verification failed. Please re-upload valid documents.');
  await prisma.driver.update({
    where: { id: driverId },
    data: { onboardingStatus: newStatus, isVerified: approved, ...(approved ? { isActive: true } : {}), documentsVerifiedAt: approved ? new Date() : null, verificationNotes },
  });
  void notifyDriverVerification({
    userId: driver.user.id,
    event: approved ? 'VERIFIED' : 'REJECTED',
    title: approved ? 'You are verified! 🎉' : 'Verification unsuccessful',
    message: approved
      ? 'All your documents have been approved. You can now go online and start accepting rides.'
      : 'Your documents could not be verified. Please re-upload valid documents in the app.',
    onboardingStatus: String(newStatus),
  });
  res.json({ success: true, message: approved ? 'All documents approved successfully' : 'All documents rejected', data: { driver_id: driverId, documents_updated: driver.documents.length, onboarding_status: newStatus, is_verified: approved, can_start_rides: approved, verification_notes: verificationNotes } });
}));

/**
 * POST /api/admin/driver/:id/verify
 * 
 * Admin endpoint to verify a driver.
 * Sets isVerified=true, onboardingStatus=COMPLETED, and verifies all documents.
 */
app.post(
  '/api/admin/driver/:id/verify',
  authenticate,
  requireVerifier,
  [body('notes').optional().isString()],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }
    
    const { id: driverId } = req.params;
    const { notes } = req.body;
    const now = new Date();
    
    const driver = await prisma.driver.findUnique({ 
      where: { id: driverId }, 
      include: { documents: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } 
    });
    
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }
    
    // Verify all documents
    await prisma.driverDocument.updateMany({
      where: { driverId },
      data: { 
        isVerified: true, 
        verifiedAt: now, 
        verifiedBy: 'ADMIN', 
        rejectionReason: null,
        verificationStatus: 'verified',
      },
    });
    
    // Update driver status
    const verificationNotes = notes || 'All documents verified. You can now start accepting rides!';
    await prisma.driver.update({
      where: { id: driverId },
      data: { 
        onboardingStatus: OnboardingStatus.COMPLETED, 
        isVerified: true, 
        isActive: true,
        documentsVerifiedAt: now, 
        verificationNotes,
      },
    });
    
    logger.info(`[ADMIN] Driver ${driverId} verified by admin ${req.user!.id}`);
    
    void notifyDriverVerification({
      userId: driver.user.id,
      event: 'VERIFIED',
      title: 'You are verified! 🎉',
      message: 'All your documents have been approved. You can now go online and start accepting rides.',
      onboardingStatus: 'COMPLETED',
    });
    
    res.json({ 
      success: true, 
      message: 'Driver verified successfully',
      data: { 
        driver_id: driverId, 
        driver_name: `${driver.user.firstName} ${driver.user.lastName}`.trim(),
        email: driver.user.email,
        documents_verified: driver.documents.length,
        onboarding_status: COMPLETED_ONBOARDING_STATUS,
        is_verified: true,
        is_active: true,
        can_start_rides: true,
        verified_at: now,
        verified_by: req.user!.id,
        verification_notes: verificationNotes,
      },
    });
  })
);

/**
 * POST /api/admin/driver/:id/reject
 * 
 * Admin endpoint to reject a driver's verification.
 * Sets isVerified=false, onboardingStatus=REJECTED, and marks all documents as rejected.
 */
app.post(
  '/api/admin/driver/:id/reject',
  authenticate,
  requireVerifier,
  [
    body('reason').isString().notEmpty().withMessage('Rejection reason is required'),
    body('notes').optional().isString(),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, errors: errors.array() });
      return;
    }
    
    const { id: driverId } = req.params;
    const { reason, notes } = req.body;
    const now = new Date();
    
    const driver = await prisma.driver.findUnique({ 
      where: { id: driverId }, 
      include: { documents: true, user: { select: { id: true, firstName: true, lastName: true, email: true } } } 
    });
    
    if (!driver) {
      res.status(404).json({ success: false, message: 'Driver not found' });
      return;
    }
    
    // Mark all documents as rejected
    await prisma.driverDocument.updateMany({
      where: { driverId },
      data: { 
        isVerified: false, 
        verifiedAt: now, 
        verifiedBy: 'ADMIN', 
        rejectionReason: reason,
        verificationStatus: 'failed',
      },
    });
    
    // Update driver status
    const verificationNotes = notes || `Verification rejected: ${reason}. Please re-upload valid documents.`;
    await prisma.driver.update({
      where: { id: driverId },
      data: { 
        onboardingStatus: OnboardingStatus.REJECTED, 
        isVerified: false, 
        documentsVerifiedAt: null, 
        verificationNotes,
      },
    });
    
    logger.info(`[ADMIN] Driver ${driverId} rejected by admin ${req.user!.id}: ${reason}`);
    
    void notifyDriverVerification({
      userId: driver.user.id,
      event: 'REJECTED',
      title: 'Verification unsuccessful',
      message: `Your documents could not be verified: ${reason}. Please re-upload valid documents in the app.`,
      onboardingStatus: 'REJECTED',
    });
    
    res.json({ 
      success: true, 
      message: 'Driver verification rejected',
      data: { 
        driver_id: driverId, 
        driver_name: `${driver.user.firstName} ${driver.user.lastName}`.trim(),
        email: driver.user.email,
        documents_rejected: driver.documents.length,
        onboarding_status: OnboardingStatus.REJECTED,
        is_verified: false,
        can_start_rides: false,
        rejected_at: now,
        rejected_by: req.user!.id,
        rejection_reason: reason,
        verification_notes: verificationNotes,
      },
    });
  })
);

app.get('/api/admin/statistics', authenticate, requireVerifier, asyncHandler(async (req: AuthRequest, res) => {
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

// ==================== PROMO MANAGEMENT (Marketing) ====================
// Proxies to pricing-service /api/promo/admin. Protected by admin JWT so the
// pricing internal key never reaches the browser. Changes reflect on the app
// immediately (pricing-service busts its promo cache on every write).

/**
 * @openapi
 * /api/admin/promos:
 *   get:
 *     tags: [Promos]
 *     summary: List all promo codes (incl. inactive/expired) with usage totals
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: List of promos }
 */
app.get(
  '/api/admin/promos',
  authenticate,
  requireAdmin,
  asyncHandler(async (_req: AuthRequest, res) => {
    const { status, data } = await pricingProxy('GET', '/api/promo/admin');
    res.status(status).json(data);
  }),
);

/**
 * @openapi
 * /api/admin/promos:
 *   post:
 *     tags: [Promos]
 *     summary: Create or update a promo code (upsert by code)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Promo saved }
 */
app.post(
  '/api/admin/promos',
  authenticate,
  requireAdmin,
  asyncHandler(async (req: AuthRequest, res) => {
    logger.info(`[ADMIN] Promo upsert by ${req.user?.email || req.user?.id}: ${req.body?.code}`);
    const { status, data } = await pricingProxy('POST', '/api/promo/admin', req.body);
    res.status(status).json(data);
  }),
);

/**
 * @openapi
 * /api/admin/promos/{id}:
 *   patch:
 *     tags: [Promos]
 *     summary: Update a promo (e.g. toggle active, change value/limits)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Promo updated }
 */
app.patch(
  '/api/admin/promos/:id',
  authenticate,
  requireAdmin,
  asyncHandler(async (req: AuthRequest, res) => {
    logger.info(`[ADMIN] Promo update by ${req.user?.email || req.user?.id}: ${req.params.id}`);
    const { status, data } = await pricingProxy('PATCH', `/api/promo/admin/${req.params.id}`, req.body);
    res.status(status).json(data);
  }),
);

/**
 * @openapi
 * /api/admin/promos/{id}:
 *   delete:
 *     tags: [Promos]
 *     summary: Delete a promo code
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Promo deleted }
 */
app.delete(
  '/api/admin/promos/:id',
  authenticate,
  requireAdmin,
  asyncHandler(async (req: AuthRequest, res) => {
    logger.info(`[ADMIN] Promo delete by ${req.user?.email || req.user?.id}: ${req.params.id}`);
    const { status, data } = await pricingProxy('DELETE', `/api/promo/admin/${req.params.id}`);
    res.status(status).json(data);
  }),
);

// ==================== BANNER MANAGEMENT (Marketing) ====================

app.get(
  '/api/admin/banners',
  authenticate,
  requireAdmin,
  asyncHandler(async (_req: AuthRequest, res) => {
    const { status, data } = await userProxy('GET', '/api/banners/admin');
    res.status(status).json(data);
  }),
);

app.post(
  '/api/admin/banners',
  authenticate,
  requireAdmin,
  asyncHandler(async (req: AuthRequest, res) => {
    logger.info(`[ADMIN] Banner create by ${req.user?.email || req.user?.id}: ${req.body?.title}`);
    const { status, data } = await userProxy('POST', '/api/banners/admin', req.body);
    res.status(status).json(data);
  }),
);

app.patch(
  '/api/admin/banners/:id',
  authenticate,
  requireAdmin,
  asyncHandler(async (req: AuthRequest, res) => {
    logger.info(`[ADMIN] Banner update by ${req.user?.email || req.user?.id}: ${req.params.id}`);
    const { status, data } = await userProxy('PATCH', `/api/banners/admin/${req.params.id}`, req.body);
    res.status(status).json(data);
  }),
);

app.delete(
  '/api/admin/banners/:id',
  authenticate,
  requireAdmin,
  asyncHandler(async (req: AuthRequest, res) => {
    logger.info(`[ADMIN] Banner delete by ${req.user?.email || req.user?.id}: ${req.params.id}`);
    const { status, data } = await userProxy('DELETE', `/api/banners/admin/${req.params.id}`);
    res.status(status).json(data);
  }),
);

app.post(
  '/api/admin/banners/upload',
  authenticate,
  requireAdmin,
  (req, res, next) => {
    bannerUploadMiddleware(req, res, (err: any) => {
      if (err) {
        res.status(400).json({ success: false, message: err.message || 'Upload failed' });
        return;
      }
      next();
    });
  },
  asyncHandler(async (req: AuthRequest, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ success: false, message: 'Image file required (field: image)' });
      return;
    }
    const imageUrl = await uploadBannerImage(file);
    res.json({ success: true, data: { imageUrl } });
  }),
);

// Serve local banner uploads in dev when S3 is not configured
app.use('/uploads/banners', express.static(path.join(process.cwd(), 'uploads', 'banners')));

// Serve the marketing dashboard (static HTML; API calls are auth-gated above).
app.get(['/promos', '/dashboard', '/dashboard/promos'], (_req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/dashboard.html'));
});

// Serve the driver document verification dashboard on its own URL, separate
// from the marketing /promos page.
app.get(['/driver-verification', '/dashboard/driver-verification'], (_req, res) => {
  res.sendFile(path.resolve(__dirname, '../public/driver-verification.html'));
});

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
