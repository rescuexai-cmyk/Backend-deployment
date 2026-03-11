import express from 'express';
import cors from 'cors';
import { body, validationResult, query } from 'express-validator';
import { connectDatabase, authenticate, errorHandler, notFound, asyncHandler, prisma, AuthRequest, setupSwagger } from '@raahi/shared';
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

// Setup Swagger documentation
setupSwagger(app, {
  title: 'User Service API',
  version: '1.0.0',
  description: 'Raahi User Service - User profile, saved places, and support tickets',
  port: Number(PORT),
  basePath: '/api/user',
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
 *                   example: user-service
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 */
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'user-service', timestamp: new Date().toISOString() });
});

// ==================== USER PROFILE ====================

/**
 * @openapi
 * /api/user/profile:
 *   get:
 *     tags: [User Profile]
 *     summary: Get user profile
 *     description: Returns the authenticated user's profile information
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: User not found
 */
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

/**
 * @openapi
 * /api/user/saved-places:
 *   get:
 *     tags: [Saved Places]
 *     summary: List saved places
 *     description: Returns paginated list of user's saved places
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of saved places
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/SavedPlace'
 *                 pagination:
 *                   $ref: '#/components/schemas/Pagination'
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Unauthorized
 */
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

/**
 * @openapi
 * /api/user/saved-places:
 *   post:
 *     tags: [Saved Places]
 *     summary: Create a saved place
 *     description: Add a new saved place (home, work, or other)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, address, latitude, longitude]
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 100
 *                 example: Home
 *               address:
 *                 type: string
 *                 maxLength: 500
 *                 example: 123 Main Street, City
 *               latitude:
 *                 type: number
 *                 minimum: -90
 *                 maximum: 90
 *                 example: 28.6139
 *               longitude:
 *                 type: number
 *                 minimum: -180
 *                 maximum: 180
 *                 example: 77.2090
 *               placeType:
 *                 type: string
 *                 enum: [home, work, other]
 *                 default: other
 *     responses:
 *       201:
 *         description: Saved place created
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
 *                   example: Saved place created
 *                 data:
 *                   $ref: '#/components/schemas/SavedPlace'
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Unauthorized
 */
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

/**
 * @openapi
 * /api/user/saved-places/{id}:
 *   put:
 *     tags: [Saved Places]
 *     summary: Update a saved place
 *     description: Update an existing saved place
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Saved place ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 100
 *               address:
 *                 type: string
 *                 maxLength: 500
 *               latitude:
 *                 type: number
 *                 minimum: -90
 *                 maximum: 90
 *               longitude:
 *                 type: number
 *                 minimum: -180
 *                 maximum: 180
 *               placeType:
 *                 type: string
 *                 enum: [home, work, other]
 *     responses:
 *       200:
 *         description: Saved place updated
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
 *                   example: Saved place updated
 *                 data:
 *                   $ref: '#/components/schemas/SavedPlace'
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Saved place not found
 */
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

/**
 * @openapi
 * /api/user/saved-places/{id}:
 *   delete:
 *     tags: [Saved Places]
 *     summary: Delete a saved place
 *     description: Remove a saved place
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Saved place ID
 *     responses:
 *       200:
 *         description: Saved place deleted
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
 *                   example: Saved place deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Saved place not found
 */
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

/**
 * @openapi
 * /api/user/support:
 *   post:
 *     tags: [Support]
 *     summary: Submit a support ticket
 *     description: Create a new support request
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
 *                 maxLength: 100
 *                 example: Payment Issue
 *               description:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 2000
 *                 example: I was charged twice for my last ride
 *               priority:
 *                 type: string
 *                 enum: [low, medium, high]
 *                 default: medium
 *     responses:
 *       201:
 *         description: Support ticket created
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
 *                   example: Support request submitted successfully
 *                 data:
 *                   $ref: '#/components/schemas/SupportTicket'
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Unauthorized
 */
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

/**
 * @openapi
 * /api/user/support:
 *   get:
 *     tags: [Support]
 *     summary: List support tickets
 *     description: Returns paginated list of user's support tickets
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Items per page
 *     responses:
 *       200:
 *         description: List of support tickets
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     tickets:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/SupportTicket'
 *                     pagination:
 *                       $ref: '#/components/schemas/Pagination'
 *       400:
 *         description: Validation failed
 *       401:
 *         description: Unauthorized
 */
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

/**
 * @openapi
 * /api/user/support/{id}:
 *   get:
 *     tags: [Support]
 *     summary: Get a support ticket
 *     description: Get details of a specific support ticket
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Support ticket ID
 *     responses:
 *       200:
 *         description: Support ticket details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   $ref: '#/components/schemas/SupportTicket'
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Support ticket not found
 */
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
