import express from 'express';
import cors from 'cors';
import { body, validationResult, query } from 'express-validator';
import { connectDatabase, authenticate, errorHandler, notFound, asyncHandler, prisma, AuthRequest } from '@raahi/shared';
import { createLogger } from '@raahi/shared';

const logger = createLogger('user-service');
const app = express();
const PORT = process.env.PORT || 5002;

// Constants for validation
const MAX_PAGINATION_LIMIT = 100;
const DEFAULT_PAGINATION_LIMIT = 20;
const VALID_PLACE_TYPES = ['home', 'work', 'other'];
const MAX_DESCRIPTION_LENGTH = 2000;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'user-service', timestamp: new Date().toISOString() });
});

// ==================== USER PROFILE ====================
// GET /api/user/profile - Return full user profile (redirects logic from /api/auth/me)
app.get('/api/user/profile', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      id: true,
      email: true,
      phone: true,
      firstName: true,
      lastName: true,
      profileImage: true,
      isVerified: true,
      isActive: true,
      createdAt: true,
      lastLoginAt: true,
    },
  });

  if (!user) {
    res.status(404).json({ success: false, message: 'User not found' });
    return;
  }

  res.json({
    success: true,
    data: {
      id: user.id,
      email: user.email ?? null,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName ?? null,
      profileImage: user.profileImage ?? null,
      isVerified: user.isVerified,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    },
  });
}));

// ==================== SAVED PLACES ====================
// GET /api/user/saved-places - List user's saved places with pagination
app.get(
  '/api/user/saved-places',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: MAX_PAGINATION_LIMIT }).withMessage(`limit must be between 1 and ${MAX_PAGINATION_LIMIT}`),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(MAX_PAGINATION_LIMIT, Math.max(1, parseInt(req.query.limit as string) || DEFAULT_PAGINATION_LIMIT));
    
    const [savedPlaces, total] = await Promise.all([
      prisma.savedPlace.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.savedPlace.count({ where: { userId: req.user!.id } }),
    ]);

    res.json({
      success: true,
      data: savedPlaces.map((p) => ({
        id: p.id,
        name: p.name,
        address: p.address,
        latitude: p.latitude,
        longitude: p.longitude,
        placeType: p.placeType,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNext: page < Math.ceil(total / limit),
        hasPrev: page > 1,
      },
    });
  })
);

// POST /api/user/saved-places - Create a new saved place
app.post(
  '/api/user/saved-places',
  authenticate,
  [
    body('name').isString().notEmpty().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required (max 100 chars)'),
    body('address').isString().notEmpty().trim().isLength({ min: 1, max: 500 }).withMessage('Address is required (max 500 chars)'),
    body('latitude').isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
    body('longitude').isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
    body('placeType').optional().isString().isIn(VALID_PLACE_TYPES).withMessage(`placeType must be one of: ${VALID_PLACE_TYPES.join(', ')}`),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { name, address, latitude, longitude, placeType } = req.body;

    const savedPlace = await prisma.savedPlace.create({
      data: {
        userId: req.user!.id,
        name,
        address,
        latitude,
        longitude,
        placeType: placeType || 'other',
      },
    });

    res.status(201).json({
      success: true,
      message: 'Saved place created',
      data: {
        id: savedPlace.id,
        name: savedPlace.name,
        address: savedPlace.address,
        latitude: savedPlace.latitude,
        longitude: savedPlace.longitude,
        placeType: savedPlace.placeType,
        createdAt: savedPlace.createdAt.toISOString(),
        updatedAt: savedPlace.updatedAt.toISOString(),
      },
    });
  })
);

// PUT /api/user/saved-places/:id - Update a saved place
app.put(
  '/api/user/saved-places/:id',
  authenticate,
  [
    body('name').optional().isString().trim().isLength({ min: 1, max: 100 }).withMessage('Name max 100 chars'),
    body('address').optional().isString().trim().isLength({ min: 1, max: 500 }).withMessage('Address max 500 chars'),
    body('latitude').optional().isFloat({ min: -90, max: 90 }).withMessage('Latitude must be between -90 and 90'),
    body('longitude').optional().isFloat({ min: -180, max: 180 }).withMessage('Longitude must be between -180 and 180'),
    body('placeType').optional().isString().isIn(VALID_PLACE_TYPES).withMessage(`placeType must be one of: ${VALID_PLACE_TYPES.join(', ')}`),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { id } = req.params;
    const { name, address, latitude, longitude, placeType } = req.body;

    // Check ownership
    const existing = await prisma.savedPlace.findFirst({
      where: { id, userId: req.user!.id },
    });
    if (!existing) {
      res.status(404).json({ success: false, message: 'Saved place not found' });
      return;
    }

    const updated = await prisma.savedPlace.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(address !== undefined && { address }),
        ...(latitude !== undefined && { latitude }),
        ...(longitude !== undefined && { longitude }),
        ...(placeType !== undefined && { placeType }),
      },
    });

    res.json({
      success: true,
      message: 'Saved place updated',
      data: {
        id: updated.id,
        name: updated.name,
        address: updated.address,
        latitude: updated.latitude,
        longitude: updated.longitude,
        placeType: updated.placeType,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  })
);

// DELETE /api/user/saved-places/:id - Delete a saved place
app.delete('/api/user/saved-places/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { id } = req.params;

  // Check ownership
  const existing = await prisma.savedPlace.findFirst({
    where: { id, userId: req.user!.id },
  });
  if (!existing) {
    res.status(404).json({ success: false, message: 'Saved place not found' });
    return;
  }

  await prisma.savedPlace.delete({ where: { id } });

  res.json({ success: true, message: 'Saved place deleted' });
}));

// ==================== USER SUPPORT TICKETS ====================
// POST /api/user/support - Submit a support ticket (persisted)
app.post(
  '/api/user/support',
  authenticate,
  [
    body('issue_type').isString().notEmpty().trim().isLength({ min: 1, max: 100 }).withMessage('Issue type is required (max 100 chars)'),
    body('description').isString().notEmpty().trim().isLength({ min: 10, max: MAX_DESCRIPTION_LENGTH }).withMessage(`Description is required (10-${MAX_DESCRIPTION_LENGTH} chars)`),
    body('priority').optional().isIn(['low', 'medium', 'high']).withMessage('Priority must be low, medium, or high'),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
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
        userId: req.user!.id,
        issueType: issue_type,
        description,
        priority: priorityMap[priority || 'medium'],
      },
    });

    res.status(201).json({
      success: true,
      message: 'Support request submitted successfully',
      data: {
        request_id: ticket.id,
        user_id: req.user!.id,
        issue_type: ticket.issueType,
        description: ticket.description,
        priority: ticket.priority.toLowerCase(),
        status: ticket.status.toLowerCase(),
        created_at: ticket.createdAt.toISOString(),
      },
    });
  })
);

// GET /api/user/support - List user's support tickets
app.get(
  '/api/user/support',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: MAX_PAGINATION_LIMIT }).withMessage(`limit must be between 1 and ${MAX_PAGINATION_LIMIT}`),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(MAX_PAGINATION_LIMIT, Math.max(1, parseInt(req.query.limit as string) || DEFAULT_PAGINATION_LIMIT));

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where: { userId: req.user!.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.supportTicket.count({ where: { userId: req.user!.id } }),
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

// GET /api/user/support/:id - Get a single support ticket
app.get('/api/user/support/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { id } = req.params;

  const ticket = await prisma.supportTicket.findFirst({
    where: { id, userId: req.user!.id },
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

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(PORT, () => logger.info(`User service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start user-service', { error: err });
  process.exit(1);
});
