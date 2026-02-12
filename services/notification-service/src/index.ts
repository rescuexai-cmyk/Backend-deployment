import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { body, query, validationResult } from 'express-validator';
import { connectDatabase, authenticate, errorHandler, notFound, asyncHandler, prisma, AuthRequest } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import * as PushService from './pushService';

const logger = createLogger('notification-service');
const app = express();
const PORT = process.env.PORT || 5006;

// Initialize Firebase for push notifications on service start
PushService.initializeFirebase();

// Internal service authentication middleware
// This ensures only other backend services can call internal endpoints
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';

const authenticateInternal = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = req.headers['x-internal-api-key'] as string;
  const forwardedFor = req.headers['x-forwarded-for'] as string;
  const remoteAddress = req.connection?.remoteAddress || req.socket?.remoteAddress;
  
  // Allow requests from localhost/internal network or with valid API key
  const isLocalRequest = remoteAddress?.includes('127.0.0.1') || 
                         remoteAddress?.includes('::1') || 
                         remoteAddress?.includes('172.') ||
                         remoteAddress?.includes('10.') ||
                         !forwardedFor; // No X-Forwarded-For means direct internal request
  
  if (apiKey === INTERNAL_API_KEY || isLocalRequest) {
    next();
    return;
  }
  
  logger.warn(`[AUTH] Unauthorized internal API access attempt from ${remoteAddress}`);
  res.status(401).json({ success: false, message: 'Unauthorized - Internal API access only' });
};

// Constants for pagination validation
const MAX_PAGINATION_LIMIT = 100;
const DEFAULT_PAGINATION_LIMIT = 20;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  const pushStatus = PushService.getPushNotificationStatus();
  res.json({ 
    status: 'OK', 
    service: 'notification-service', 
    timestamp: new Date().toISOString(),
    pushNotifications: pushStatus,
  });
});

// ============================================
// DEVICE REGISTRATION ENDPOINTS
// ============================================

/**
 * POST /api/notifications/device - Register/update device for push notifications
 * 
 * Call this endpoint when:
 * - User logs in (to register device)
 * - FCM token refreshes (Firebase can rotate tokens)
 * - User switches devices
 */
app.post(
  '/api/notifications/device',
  authenticate,
  [
    body('fcmToken').isString().notEmpty().isLength({ min: 20, max: 500 }).withMessage('fcmToken is required'),
    body('platform').isIn(['ios', 'android', 'web']).withMessage('platform must be ios, android, or web'),
    body('deviceId').optional().isString().isLength({ max: 200 }),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { fcmToken, platform, deviceId } = req.body;
    const userId = req.user!.id;

    // Update user's device token
    await prisma.user.update({
      where: { id: userId },
      data: {
        fcmToken,
        devicePlatform: platform,
        deviceId: deviceId || null,
        fcmTokenUpdatedAt: new Date(),
      },
    });

    logger.info('[DEVICE] FCM token registered', { userId, platform, hasDeviceId: !!deviceId });

    res.json({
      success: true,
      message: 'Device registered for push notifications',
      data: {
        platform,
        pushEnabled: PushService.getPushNotificationStatus().enabled,
      },
    });
  })
);

/**
 * DELETE /api/notifications/device - Unregister device (logout, disable notifications)
 */
app.delete('/api/notifications/device', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const userId = req.user!.id;

  await prisma.user.update({
    where: { id: userId },
    data: {
      fcmToken: null,
      devicePlatform: null,
      deviceId: null,
      fcmTokenUpdatedAt: null,
    },
  });

  logger.info('[DEVICE] FCM token removed', { userId });

  res.json({
    success: true,
    message: 'Device unregistered from push notifications',
  });
}));

/**
 * GET /api/notifications/device - Get current device registration status
 */
app.get('/api/notifications/device', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      fcmToken: true,
      devicePlatform: true,
      deviceId: true,
      fcmTokenUpdatedAt: true,
    },
  });

  res.json({
    success: true,
    data: {
      isRegistered: !!user?.fcmToken,
      platform: user?.devicePlatform || null,
      deviceId: user?.deviceId || null,
      lastUpdated: user?.fcmTokenUpdatedAt?.toISOString() || null,
      pushEnabled: PushService.getPushNotificationStatus().enabled,
    },
  });
}));

/**
 * POST /api/notifications/test-push - Send a test push notification (dev/debug)
 */
app.post('/api/notifications/test-push', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { fcmToken: true, firstName: true },
  });

  if (!user?.fcmToken) {
    res.status(400).json({ 
      success: false, 
      message: 'No FCM token registered. Please register your device first.' 
    });
    return;
  }

  const result = await PushService.sendPushNotification(user.fcmToken, {
    title: '🔔 Test Notification',
    body: `Hi ${user.firstName || 'there'}! Push notifications are working.`,
    data: {
      type: 'TEST',
      timestamp: new Date().toISOString(),
    },
  });

  if (result.success) {
    res.json({
      success: true,
      message: 'Test notification sent successfully',
      data: { messageId: result.messageId },
    });
  } else {
    // If token is invalid, clear it from the database
    if (result.invalidToken) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { fcmToken: null, fcmTokenUpdatedAt: null },
      });
    }
    res.status(500).json({
      success: false,
      message: result.error || 'Failed to send test notification',
      invalidToken: result.invalidToken,
    });
  }
}));

// GET /api/notifications - List user's notifications with pagination
app.get(
  '/api/notifications',
  authenticate,
  [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: MAX_PAGINATION_LIMIT }).withMessage(`limit must be between 1 and ${MAX_PAGINATION_LIMIT}`),
    query('unread_only').optional().isBoolean(),
  ],
  asyncHandler(async (req: AuthRequest, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }
    
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(MAX_PAGINATION_LIMIT, Math.max(1, parseInt(req.query.limit as string) || DEFAULT_PAGINATION_LIMIT));
    const unreadOnly = req.query.unread_only === 'true';

    const whereClause: { userId: string; isRead?: boolean } = { userId: req.user!.id };
    if (unreadOnly) {
      whereClause.isRead = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({ where: whereClause }),
      prisma.notification.count({ where: { userId: req.user!.id, isRead: false } }),
    ]);

    res.json({
      success: true,
      data: {
        notifications: notifications.map((n) => ({
          id: n.id,
          title: n.title,
          message: n.message,
          type: n.type.toLowerCase(),
          isRead: n.isRead,
          data: n.data,
          createdAt: n.createdAt.toISOString(),
        })),
        unreadCount,
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

// POST /api/notifications/:id/read - Mark a single notification as read
app.post('/api/notifications/:id/read', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { id } = req.params;

  // Check ownership
  const notification = await prisma.notification.findFirst({
    where: { id, userId: req.user!.id },
  });

  if (!notification) {
    res.status(404).json({ success: false, message: 'Notification not found' });
    return;
  }

  const updated = await prisma.notification.update({
    where: { id },
    data: { isRead: true },
  });

  res.json({
    success: true,
    message: 'Notification marked as read',
    data: {
      id: updated.id,
      isRead: updated.isRead,
    },
  });
}));

// POST /api/notifications/read-all - Mark all notifications as read
app.post('/api/notifications/read-all', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const result = await prisma.notification.updateMany({
    where: { userId: req.user!.id, isRead: false },
    data: { isRead: true },
  });

  res.json({
    success: true,
    message: `${result.count} notifications marked as read`,
    data: { markedCount: result.count },
  });
}));

// DELETE /api/notifications/:id - Delete a notification
app.delete('/api/notifications/:id', authenticate, asyncHandler(async (req: AuthRequest, res) => {
  const { id } = req.params;

  // Check ownership
  const notification = await prisma.notification.findFirst({
    where: { id, userId: req.user!.id },
  });

  if (!notification) {
    res.status(404).json({ success: false, message: 'Notification not found' });
    return;
  }

  await prisma.notification.delete({ where: { id } });

  res.json({ success: true, message: 'Notification deleted' });
}));

// Internal endpoint to create notifications (called by other services)
// Protected by internal API key authentication
// Now also sends push notifications via FCM
app.post(
  '/api/notifications/internal/create',
  authenticateInternal,
  [
    body('userId').isString().notEmpty().withMessage('userId is required'),
    body('title').isString().notEmpty().isLength({ max: 200 }).withMessage('title is required and max 200 chars'),
    body('message').isString().notEmpty().isLength({ max: 1000 }).withMessage('message is required and max 1000 chars'),
    body('type').isIn(['RIDE_UPDATE', 'PAYMENT', 'PROMOTION', 'SYSTEM', 'SUPPORT']).withMessage('Invalid notification type'),
    body('data').optional().isObject(),
    body('sendPush').optional().isBoolean(), // Default true - send push notification
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { userId, title, message, type, data, sendPush = true } = req.body;

    // Verify user exists and get FCM token
    const user = await prisma.user.findUnique({ 
      where: { id: userId }, 
      select: { id: true, fcmToken: true, firstName: true } 
    });
    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    // Create notification in database
    const notification = await prisma.notification.create({
      data: {
        userId,
        title,
        message,
        type,
        data: data || undefined,
      },
    });

    logger.info('[NOTIFICATION] Created', { notificationId: notification.id, userId, type });

    // Send push notification if enabled and user has FCM token
    let pushResult: { success: boolean; messageId?: string; error?: string; invalidToken?: boolean } | null = null;
    if (sendPush && user.fcmToken) {
      pushResult = await PushService.sendPushNotification(user.fcmToken, {
        title,
        body: message,
        data: {
          notificationId: notification.id,
          type,
          ...(data || {}),
        },
        android: {
          channelId: getAndroidChannelForType(type),
          priority: 'high',
        },
        apns: {
          sound: 'default',
          category: type,
        },
      });

      // If token is invalid, clear it
      if (pushResult.invalidToken) {
        await prisma.user.update({
          where: { id: userId },
          data: { fcmToken: null, fcmTokenUpdatedAt: null },
        });
        logger.warn('[NOTIFICATION] Cleared invalid FCM token', { userId });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        id: notification.id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        createdAt: notification.createdAt.toISOString(),
        push: {
          sent: !!pushResult,
          success: pushResult?.success || false,
          messageId: pushResult?.messageId,
          error: pushResult?.error,
        },
      },
    });
  })
);

/**
 * Get Android notification channel based on notification type
 */
function getAndroidChannelForType(type: string): string {
  switch (type) {
    case 'RIDE_UPDATE':
      return 'raahi_rides';
    case 'PAYMENT':
      return 'raahi_payments';
    case 'PROMOTION':
      return 'raahi_promotions';
    case 'SYSTEM':
      return 'raahi_system';
    case 'SUPPORT':
      return 'raahi_support';
    default:
      return 'raahi_default';
  }
}

/**
 * Internal endpoint to send push notification to a specific user
 * Use this for custom push payloads (e.g., ride-specific templates)
 */
app.post(
  '/api/notifications/internal/push',
  authenticateInternal,
  [
    body('userId').isString().notEmpty().withMessage('userId is required'),
    body('title').isString().notEmpty().isLength({ max: 200 }).withMessage('title is required'),
    body('body').isString().notEmpty().isLength({ max: 1000 }).withMessage('body is required'),
    body('data').optional().isObject(),
    body('android').optional().isObject(),
    body('apns').optional().isObject(),
    body('saveToDb').optional().isBoolean(), // Default false - just send push, don't save
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { userId, title, body: pushBody, data, android, apns, saveToDb = false } = req.body;

    // Get user's FCM token
    const user = await prisma.user.findUnique({ 
      where: { id: userId }, 
      select: { id: true, fcmToken: true } 
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (!user.fcmToken) {
      res.status(400).json({ 
        success: false, 
        message: 'User has no registered device for push notifications' 
      });
      return;
    }

    // Optionally save to database
    let notificationId: string | null = null;
    if (saveToDb) {
      const notification = await prisma.notification.create({
        data: {
          userId,
          title,
          message: pushBody,
          type: data?.type || 'SYSTEM',
          data: data || undefined,
        },
      });
      notificationId = notification.id;
    }

    // Send push notification
    const result = await PushService.sendPushNotification(user.fcmToken, {
      title,
      body: pushBody,
      data: {
        ...(data || {}),
        notificationId: notificationId || '',
      },
      android,
      apns,
    });

    // Clear invalid token
    if (result.invalidToken) {
      await prisma.user.update({
        where: { id: userId },
        data: { fcmToken: null, fcmTokenUpdatedAt: null },
      });
    }

    res.json({
      success: result.success,
      data: {
        messageId: result.messageId,
        notificationId,
        error: result.error,
        invalidToken: result.invalidToken,
      },
    });
  })
);

/**
 * Internal endpoint for ride-specific push notifications with templates
 * Handles all ride-related notifications with proper formatting
 */
app.post(
  '/api/notifications/internal/ride-push',
  authenticateInternal,
  [
    body('userId').isString().notEmpty().withMessage('userId is required'),
    body('event').isIn([
      'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 
      'RIDE_STARTED', 'RIDE_COMPLETED_PASSENGER', 'RIDE_COMPLETED_DRIVER',
      'RIDE_CANCELLED_TO_DRIVER', 'RIDE_CANCELLED_TO_PASSENGER',
      'NEW_RIDE_REQUEST', 'OTP_REMINDER'
    ]).withMessage('Invalid ride event'),
    body('rideId').optional().isString(),
    body('eventData').isObject().withMessage('eventData is required'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { userId, event, rideId, eventData } = req.body;

    // Get user's FCM token
    const user = await prisma.user.findUnique({ 
      where: { id: userId }, 
      select: { id: true, fcmToken: true } 
    });

    if (!user) {
      res.status(404).json({ success: false, message: 'User not found' });
      return;
    }

    if (!user.fcmToken) {
      logger.info('[RIDE-PUSH] User has no FCM token', { userId, event });
      res.json({ 
        success: false, 
        message: 'User has no registered device',
        noToken: true,
      });
      return;
    }

    // Build notification payload based on event type
    let payload: PushService.PushNotificationPayload;
    switch (event) {
      case 'DRIVER_ASSIGNED':
        payload = PushService.buildDriverAssignedNotification(
          eventData.driverName,
          eventData.vehicleInfo,
          eventData.eta,
          rideId
        );
        break;
      case 'DRIVER_ARRIVING':
        payload = PushService.buildDriverArrivingNotification(
          eventData.driverName,
          eventData.eta,
          rideId
        );
        break;
      case 'DRIVER_ARRIVED':
        payload = PushService.buildDriverArrivedNotification(
          eventData.driverName,
          eventData.otp,
          rideId
        );
        break;
      case 'RIDE_STARTED':
        payload = PushService.buildRideStartedNotification(
          eventData.driverName,
          eventData.destination,
          rideId
        );
        break;
      case 'RIDE_COMPLETED_PASSENGER':
        payload = PushService.buildRideCompletedPassengerNotification(
          eventData.fare,
          eventData.distance,
          rideId
        );
        break;
      case 'RIDE_COMPLETED_DRIVER':
        payload = PushService.buildRideCompletedDriverNotification(
          eventData.earnings,
          rideId
        );
        break;
      case 'RIDE_CANCELLED_TO_DRIVER':
        payload = PushService.buildRideCancelledToDriverNotification(
          eventData.passengerName,
          eventData.reason,
          rideId
        );
        break;
      case 'RIDE_CANCELLED_TO_PASSENGER':
        payload = PushService.buildRideCancelledToPassengerNotification(
          eventData.driverName,
          eventData.reason,
          rideId
        );
        break;
      case 'NEW_RIDE_REQUEST':
        payload = PushService.buildNewRideRequestNotification(
          eventData.pickupAddress,
          eventData.estimatedFare,
          eventData.distance,
          rideId
        );
        break;
      case 'OTP_REMINDER':
        payload = PushService.buildOtpReminderNotification(
          eventData.otp,
          eventData.driverName,
          rideId
        );
        break;
      default:
        res.status(400).json({ success: false, message: 'Unknown event type' });
        return;
    }

    // Send push notification
    const result = await PushService.sendPushNotification(user.fcmToken, payload);

    // Clear invalid token
    if (result.invalidToken) {
      await prisma.user.update({
        where: { id: userId },
        data: { fcmToken: null, fcmTokenUpdatedAt: null },
      });
    }

    // Also save to notification database
    const notification = await prisma.notification.create({
      data: {
        userId,
        title: payload.title,
        message: payload.body,
        type: 'RIDE_UPDATE',
        data: payload.data || undefined,
      },
    });

    logger.info('[RIDE-PUSH] Notification sent', { 
      userId, 
      event, 
      rideId, 
      pushSuccess: result.success,
      notificationId: notification.id,
    });

    res.json({
      success: result.success,
      data: {
        messageId: result.messageId,
        notificationId: notification.id,
        error: result.error,
        invalidToken: result.invalidToken,
      },
    });
  })
);

/**
 * GEO-TAGGED NOTIFICATION ENDPOINT
 * 
 * Creates notifications for all users within a geographic area.
 * Uses user's last known location or saved places (home/work) to determine if they're in the target area.
 * 
 * @example
 * POST /api/notifications/internal/create-geo
 * {
 *   "latitude": 28.6139,
 *   "longitude": 77.2090,
 *   "radius": 5,  // km
 *   "title": "Special offer in your area!",
 *   "message": "Get 20% off your next ride",
 *   "type": "PROMOTION",
 *   "data": { "promoCode": "AREA20" }
 * }
 */
app.post(
  '/api/notifications/internal/create-geo',
  authenticateInternal,
  [
    body('latitude').isFloat({ min: -90, max: 90 }).withMessage('latitude must be between -90 and 90'),
    body('longitude').isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),
    body('radius').isFloat({ min: 0.1, max: 100 }).withMessage('radius must be between 0.1 and 100 km'),
    body('title').isString().notEmpty().isLength({ max: 200 }).withMessage('title is required and max 200 chars'),
    body('message').isString().notEmpty().isLength({ max: 1000 }).withMessage('message is required and max 1000 chars'),
    body('type').isIn(['RIDE_UPDATE', 'PAYMENT', 'PROMOTION', 'SYSTEM', 'SUPPORT']).withMessage('Invalid notification type'),
    body('data').optional().isObject(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { latitude, longitude, radius, title, message, type, data } = req.body;

    logger.info(`[GEO-NOTIFICATION] Creating geo-tagged notification at (${latitude}, ${longitude}) with radius ${radius}km`);

    // Calculate lat/lng bounds for the radius
    // 1 degree of latitude ≈ 111 km
    // 1 degree of longitude ≈ 111 * cos(latitude) km
    const latRange = radius / 111;
    const lngRange = radius / (111 * Math.cos((latitude * Math.PI) / 180));

    const minLat = latitude - latRange;
    const maxLat = latitude + latRange;
    const minLng = longitude - lngRange;
    const maxLng = longitude + lngRange;

    // Find users within the geographic area based on:
    // 1. Their last known location
    // 2. Their saved places (home, work)
    const [usersWithLocation, usersWithSavedPlaces] = await Promise.all([
      // Users with recent location (within last 30 days)
      prisma.user.findMany({
        where: {
          isActive: true,
          lastLatitude: { gte: minLat, lte: maxLat },
          lastLongitude: { gte: minLng, lte: maxLng },
          lastLocationAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
        select: { id: true },
      }),
      // Users with saved places in the area
      prisma.savedPlace.findMany({
        where: {
          latitude: { gte: minLat, lte: maxLat },
          longitude: { gte: minLng, lte: maxLng },
          user: { isActive: true },
        },
        select: { userId: true },
        distinct: ['userId'],
      }),
    ]);

    // Combine and deduplicate user IDs
    const userIdSet = new Set<string>();
    usersWithLocation.forEach(u => userIdSet.add(u.id));
    usersWithSavedPlaces.forEach(u => userIdSet.add(u.userId));
    const targetUserIds = Array.from(userIdSet);

    if (targetUserIds.length === 0) {
      logger.info(`[GEO-NOTIFICATION] No users found in target area`);
      res.status(200).json({
        success: true,
        message: 'No users found in the target geographic area',
        data: {
          targetArea: { latitude, longitude, radius },
          notificationsSent: 0,
          targetUserIds: [],
        },
      });
      return;
    }

    logger.info(`[GEO-NOTIFICATION] Found ${targetUserIds.length} users in target area`);

    // Create notifications for all users in the area
    const notifications = await prisma.notification.createMany({
      data: targetUserIds.map(userId => ({
        userId,
        title,
        message,
        type,
        data: data || undefined,
        targetLatitude: latitude,
        targetLongitude: longitude,
        targetRadius: radius,
      })),
    });

    logger.info(`[GEO-NOTIFICATION] Created ${notifications.count} geo-tagged notifications`);

    res.status(201).json({
      success: true,
      message: `Geo-tagged notifications sent to ${notifications.count} users`,
      data: {
        targetArea: { latitude, longitude, radius },
        notificationsSent: notifications.count,
        targetUserIds,
      },
    });
  })
);

/**
 * Update user's last known location
 * Called when user opens app, requests a ride, etc.
 */
app.post(
  '/api/notifications/internal/update-user-location',
  authenticateInternal,
  [
    body('userId').isString().notEmpty().withMessage('userId is required'),
    body('latitude').isFloat({ min: -90, max: 90 }).withMessage('latitude must be between -90 and 90'),
    body('longitude').isFloat({ min: -180, max: 180 }).withMessage('longitude must be between -180 and 180'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
      return;
    }

    const { userId, latitude, longitude } = req.body;

    await prisma.user.update({
      where: { id: userId },
      data: {
        lastLatitude: latitude,
        lastLongitude: longitude,
        lastLocationAt: new Date(),
      },
    });

    res.json({ success: true, message: 'User location updated' });
  })
);

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(PORT, () => logger.info(`Notification service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start notification-service', { error: err });
  process.exit(1);
});
