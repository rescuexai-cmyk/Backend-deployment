import { getDistance } from 'geolib';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import {
  calculateFare as httpCalculateFare,
  getNearbyDrivers as httpGetNearbyDrivers,
  broadcastRideRequest as httpBroadcastRideRequest,
  broadcastRideStatusUpdate,
  broadcastDriverAssigned,
  broadcastRideCancelled,
  updateDriverLocationRealtime,
} from './httpClients';

const logger = createLogger('ride-service');

// ==================== NOTIFICATION HELPER ====================
interface NotificationData {
  userId: string;
  title: string;
  message: string;
  type: 'RIDE_UPDATE' | 'PAYMENT' | 'PROMOTION' | 'SYSTEM' | 'SUPPORT';
  data?: Record<string, any>;
}

// Notification service URL for push notifications
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5006';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';

/**
 * Create a notification for a user AND send push notification
 * Non-blocking - failures are logged but don't break the main flow
 */
async function createNotification(notification: NotificationData): Promise<void> {
  try {
    // Create notification in database directly
    await prisma.notification.create({
      data: {
        userId: notification.userId,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        data: notification.data || undefined,
      },
    });
    logger.info(`[NOTIFICATION] Created notification for user ${notification.userId}: ${notification.title}`);
    
    // Also send push notification via notification service
    sendPushNotificationAsync(notification);
  } catch (error) {
    logger.error(`[NOTIFICATION] Failed to create notification for user ${notification.userId}`, { error });
    // Don't throw - notifications are non-critical
  }
}

/**
 * Send push notification via notification service (non-blocking)
 */
async function sendPushNotificationAsync(notification: NotificationData): Promise<void> {
  try {
    const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications/internal/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        userId: notification.userId,
        title: notification.title,
        body: notification.message,
        data: {
          type: notification.type,
          ...notification.data,
        },
        saveToDb: false, // Already saved above
      }),
    });
    
    if (response.ok) {
      const result = await response.json();
      if (result.success) {
        logger.info(`[PUSH] Sent push notification to user ${notification.userId}`);
      } else if (result.data?.noToken) {
        logger.debug(`[PUSH] User ${notification.userId} has no FCM token registered`);
      } else {
        logger.warn(`[PUSH] Push notification failed for user ${notification.userId}: ${result.data?.error || 'unknown'}`);
      }
    } else {
      logger.warn(`[PUSH] Notification service returned ${response.status} for user ${notification.userId}`);
    }
  } catch (error) {
    logger.warn(`[PUSH] Failed to send push notification to user ${notification.userId}`, { error });
    // Don't throw - push notifications are non-critical
  }
}

/**
 * Send ride-specific push notification using templates
 */
async function sendRidePushNotification(
  userId: string,
  event: string,
  rideId: string,
  eventData: Record<string, any>
): Promise<void> {
  try {
    const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications/internal/ride-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        userId,
        event,
        rideId,
        eventData,
      }),
    });
    
    if (response.ok) {
      const result = await response.json();
      if (result.success) {
        logger.info(`[PUSH] Sent ${event} push notification to user ${userId} for ride ${rideId}`);
      }
    }
  } catch (error) {
    logger.warn(`[PUSH] Failed to send ${event} push notification`, { error, userId, rideId });
  }
}

/**
 * Get user ID from driver ID
 */
async function getDriverUserId(driverId: string): Promise<string | null> {
  try {
    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    });
    return driver?.userId || null;
  } catch (error) {
    logger.error(`[NOTIFICATION] Failed to get driver user ID for ${driverId}`, { error });
    return null;
  }
}

export interface CreateRideRequest {
  passengerId: string;
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  pickupAddress: string;
  dropAddress: string;
  paymentMethod: 'CASH' | 'CARD' | 'UPI' | 'WALLET';
  scheduledTime?: Date;
  vehicleType?: string;
}

function calcDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return getDistance({ latitude: lat1, longitude: lng1 }, { latitude: lat2, longitude: lng2 }) / 1000;
}

/**
 * Generate a 4-digit OTP for ride verification
 * Driver must enter this OTP to start the ride
 */
function generateRideOtp(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Format ride for API response
 * @param ride - The ride object from database
 * @param includeOtp - Whether to include the OTP (only for passenger)
 */
function formatRide(ride: any, includeOtp: boolean = false) {
  return {
    id: ride.id,
    passengerId: ride.passengerId,
    driverId: ride.driverId,
    pickupLat: ride.pickupLatitude,
    pickupLng: ride.pickupLongitude,
    dropLat: ride.dropLatitude,
    dropLng: ride.dropLongitude,
    pickupAddress: ride.pickupAddress,
    dropAddress: ride.dropAddress,
    distance: ride.distance,
    duration: ride.duration,
    baseFare: ride.baseFare,
    distanceFare: ride.distanceFare,
    timeFare: ride.timeFare,
    surgeMultiplier: ride.surgeMultiplier,
    totalFare: ride.totalFare,
    status: ride.status,
    paymentMethod: ride.paymentMethod,
    paymentStatus: ride.paymentStatus,
    // Only include OTP for passenger (they need to share it with driver)
    rideOtp: includeOtp ? ride.rideOtp : undefined,
    scheduledAt: ride.scheduledAt,
    startedAt: ride.startedAt,
    completedAt: ride.completedAt,
    cancelledAt: ride.cancelledAt,
    cancellationReason: ride.cancellationReason,
    createdAt: ride.createdAt,
    updatedAt: ride.updatedAt,
    driver: ride.driver
      ? {
          id: ride.driver.id,
          firstName: ride.driver.user?.firstName,
          lastName: ride.driver.user?.lastName,
          profileImage: ride.driver.user?.profileImage,
          rating: ride.driver.rating,
          vehicleNumber: ride.driver.vehicleNumber,
          vehicleModel: ride.driver.vehicleModel,
          phone: ride.driver.user?.phone,
        }
      : undefined,
  };
}

export async function createRide(req: CreateRideRequest) {
  const pricing = await httpCalculateFare({
    pickupLat: req.pickupLat,
    pickupLng: req.pickupLng,
    dropLat: req.dropLat,
    dropLng: req.dropLng,
    vehicleType: req.vehicleType,
    scheduledTime: req.scheduledTime?.toISOString(),
  });

  // Generate 4-digit OTP for ride verification
  const rideOtp = generateRideOtp();
  logger.info(`[RIDE] Generated OTP ${rideOtp} for new ride`);

  // Update user's last known location (for geo-tagged notifications)
  await prisma.user.update({
    where: { id: req.passengerId },
    data: {
      lastLatitude: req.pickupLat,
      lastLongitude: req.pickupLng,
      lastLocationAt: new Date(),
    },
  }).catch(err => {
    // Non-blocking - don't fail ride creation if location update fails
    logger.warn(`[RIDE] Failed to update user location: ${err.message}`);
  });

  const ride = await prisma.ride.create({
    data: {
      passengerId: req.passengerId,
      pickupLatitude: req.pickupLat,
      pickupLongitude: req.pickupLng,
      dropLatitude: req.dropLat,
      dropLongitude: req.dropLng,
      pickupAddress: req.pickupAddress,
      dropAddress: req.dropAddress,
      distance: pricing.distance,
      duration: pricing.estimatedDuration,
      baseFare: pricing.baseFare,
      distanceFare: pricing.distanceFare,
      timeFare: pricing.timeFare,
      surgeMultiplier: pricing.surgeMultiplier,
      totalFare: pricing.totalFare,
      paymentMethod: req.paymentMethod,
      scheduledAt: req.scheduledTime,
      rideOtp, // Store OTP in database
    },
  });

  try {
    logger.info(`[RIDE] ========== RIDE BROADCAST START ==========`);
    logger.info(`[RIDE] Ride ID: ${ride.id}`);
    logger.info(`[RIDE] Pickup: ${req.pickupAddress} (${req.pickupLat}, ${req.pickupLng})`);
    logger.info(`[RIDE] Fare: ₹${pricing.totalFare}`);
    
    logger.info(`[RIDE] Fetching nearby drivers...`);
    const nearbyDrivers = await httpGetNearbyDrivers(req.pickupLat, req.pickupLng, 10);
    const driverIds = nearbyDrivers.map((d: { id: string }) => d.id);
    
    logger.info(`[RIDE] Found ${driverIds.length} nearby drivers: ${JSON.stringify(driverIds)}`);
    
    if (driverIds.length === 0) {
      logger.warn(`[RIDE] ⚠️ NO NEARBY DRIVERS for ride ${ride.id}`);
      logger.warn(`[RIDE] This ride will be broadcast to available-drivers room only`);
    }
    
    logger.info(`[RIDE] Broadcasting ride request to realtime service...`);
    const broadcastResult = await httpBroadcastRideRequest(ride.id, {
      ...ride,
      pickupLatitude: req.pickupLat,
      pickupLongitude: req.pickupLng,
      dropLatitude: req.dropLat,
      dropLongitude: req.dropLng,
      pickupAddress: req.pickupAddress,
      dropAddress: req.dropAddress,
      totalFare: pricing.totalFare,
      vehicleType: req.vehicleType,
      passengerName: 'Passenger',
    }, driverIds);
    
    // Log broadcast result
    if (broadcastResult) {
      logger.info(`[RIDE] Broadcast result:`);
      logger.info(`[RIDE]   - Success: ${broadcastResult.success}`);
      logger.info(`[RIDE]   - Targeted drivers: ${broadcastResult.targetedDrivers}`);
      logger.info(`[RIDE]   - Available drivers room: ${broadcastResult.availableDrivers}`);
      logger.info(`[RIDE]   - Total connected: ${broadcastResult.connectedDrivers}`);
      
      if (broadcastResult.errors.length > 0) {
        logger.error(`[RIDE]   - Errors: ${JSON.stringify(broadcastResult.errors)}`);
      }
      
      // P0 FAIL-FAST: Log critical warning if no drivers received broadcast
      if (!broadcastResult.success) {
        logger.error(`[RIDE] 🚨🚨🚨 P0 FAILURE: Ride ${ride.id} was NOT delivered to ANY driver! 🚨🚨🚨`);
        logger.error(`[RIDE] Passenger will be waiting but no driver will see this ride`);
        logger.error(`[RIDE] Eligible drivers: ${driverIds.length}, Connected: ${broadcastResult.connectedDrivers}`);
      } else {
        logger.info(`[RIDE] ✅ Ride ${ride.id} broadcast successful`);
      }
    } else {
      logger.warn(`[RIDE] ⚠️ No broadcast result returned - unable to verify delivery`);
    }
    
    logger.info(`[RIDE] ========== RIDE BROADCAST END ==========`);
  } catch (e) {
    logger.error(`[RIDE] 🚨 Broadcast ride request FAILED for ride ${ride.id}`, { error: e });
  }

  // Return ride with OTP for passenger (they created the ride)
  return formatRide(ride, true);
}

export async function getRideById(rideId: string, requesterId?: string) {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: {
      passenger: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
      driver: {
        include: {
          user: { select: { firstName: true, lastName: true, profileImage: true, phone: true } },
        },
      },
    },
  });
  if (!ride) return null;
  
  // Only include OTP if requester is the passenger
  const includeOtp = requesterId === ride.passengerId;
  
  return {
    ...formatRide(ride, includeOtp),
    passenger: ride.passenger,
    pickupLatitude: ride.pickupLatitude,
    pickupLongitude: ride.pickupLongitude,
    dropLatitude: ride.dropLatitude,
    dropLongitude: ride.dropLongitude,
  };
}

export async function getUserRides(userId: string, page: number = 1, limit: number = 10) {
  const [rides, total] = await Promise.all([
    prisma.ride.findMany({
      where: { passengerId: userId },
      include: {
        driver: {
          include: {
            user: { select: { firstName: true, lastName: true, profileImage: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.ride.count({ where: { passengerId: userId } }),
  ]);
  return {
    // Include OTP for passenger's own rides
    rides: rides.map(ride => formatRide(ride, true)),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Assigns a driver to a ride with race condition protection.
 * Uses a database transaction with optimistic locking to prevent double assignment.
 * @throws Error if ride is already assigned or not in PENDING status
 */
export async function assignDriver(rideId: string, driverId: string) {
  // Use transaction with optimistic locking to prevent race conditions
  const ride = await prisma.$transaction(async (tx) => {
    // First, check the current state of the ride
    const currentRide = await tx.ride.findUnique({
      where: { id: rideId },
      select: { id: true, status: true, driverId: true, updatedAt: true },
    });

    if (!currentRide) {
      throw new Error('Ride not found');
    }

    // Check if ride is already assigned
    if (currentRide.driverId) {
      throw new Error('Ride is already assigned to another driver');
    }

    // Only allow assignment for PENDING rides
    if (currentRide.status !== 'PENDING') {
      throw new Error(`Cannot assign driver to ride with status: ${currentRide.status}`);
    }

    // Check if driver exists and is available
    const driver = await tx.driver.findUnique({
      where: { id: driverId },
      select: { id: true, isOnline: true, isActive: true },
    });

    if (!driver) {
      throw new Error('Driver not found');
    }

    if (!driver.isOnline) {
      throw new Error('Driver is not online');
    }

    if (!driver.isActive) {
      throw new Error('Driver account is not active');
    }

    // Perform the atomic update with WHERE clause to ensure no concurrent modification
    // This uses optimistic locking - if another transaction modified the ride, this will fail
    const updatedRide = await tx.ride.update({
      where: {
        id: rideId,
        driverId: null, // Only update if still unassigned (optimistic lock)
        status: 'PENDING', // Only update if still pending
      },
      data: {
        driverId,
        status: 'DRIVER_ASSIGNED',
      },
      include: {
        driver: {
          include: {
            user: { select: { firstName: true, lastName: true, profileImage: true, phone: true } },
          },
        },
      },
    });

    return updatedRide;
  }, {
    // Set isolation level to prevent phantom reads
    isolationLevel: 'Serializable',
    timeout: 10000, // 10 second timeout
  });

  logger.info(`Driver ${driverId} assigned to ride ${rideId}`);

  // Broadcast the assignment (outside transaction to not block)
  try {
    await broadcastDriverAssigned(rideId, {
      id: ride.driver?.id,
      name: ride.driver?.user ? `${ride.driver.user.firstName} ${ride.driver.user.lastName || ''}`.trim() : '',
      phone: ride.driver?.user?.phone,
      vehicleNumber: ride.driver?.vehicleNumber,
      vehicleModel: ride.driver?.vehicleModel,
      rating: ride.driver?.rating,
      profileImage: ride.driver?.user?.profileImage,
    });
  } catch (e) {
    logger.error('Broadcast driver assigned failed', { error: e });
  }

  // Get passenger info for notification
  const passengerRide = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { passengerId: true, pickupAddress: true },
  });

  // CRITICAL: Send notification to passenger that driver is assigned
  if (passengerRide) {
    const driverName = ride.driver?.user ? `${ride.driver.user.firstName} ${ride.driver.user.lastName || ''}`.trim() : 'Your driver';
    const vehicleInfo = `${ride.driver?.vehicleModel || 'Vehicle'} (${ride.driver?.vehicleNumber || ''})`;
    
    // Send database notification
    await createNotification({
      userId: passengerRide.passengerId,
      title: 'Driver Assigned',
      message: `${driverName} is on the way to pick you up. ${vehicleInfo}`,
      type: 'RIDE_UPDATE',
      data: {
        rideId,
        driverId,
        driverName,
        vehicleNumber: ride.driver?.vehicleNumber,
        vehicleModel: ride.driver?.vehicleModel,
        event: 'DRIVER_ASSIGNED',
      },
    });
    
    // Send rich push notification with template
    sendRidePushNotification(passengerRide.passengerId, 'DRIVER_ASSIGNED', rideId, {
      driverName,
      vehicleInfo,
      eta: 5, // TODO: Calculate actual ETA based on distance
    });
  }

  return formatRide(ride);
}

// Valid status transitions to prevent invalid state changes
const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  'PENDING': ['DRIVER_ASSIGNED', 'CANCELLED'],
  'DRIVER_ASSIGNED': ['CONFIRMED', 'CANCELLED'],
  'CONFIRMED': ['DRIVER_ARRIVED', 'CANCELLED'],
  'DRIVER_ARRIVED': ['RIDE_STARTED', 'CANCELLED'],
  'RIDE_STARTED': ['RIDE_COMPLETED', 'CANCELLED'],
  'RIDE_COMPLETED': [], // Terminal state
  'CANCELLED': [], // Terminal state
};

export async function updateRideStatus(
  rideId: string,
  status: 'CONFIRMED' | 'DRIVER_ARRIVED' | 'RIDE_STARTED' | 'RIDE_COMPLETED' | 'CANCELLED',
  _userId: string,
  cancellationReason?: string
) {
  // First, get current ride status for validation
  const currentRide = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { status: true, driverId: true },
  });
  
  if (!currentRide) {
    throw new Error('Ride not found');
  }
  
  // Validate status transition
  const allowedTransitions = VALID_STATUS_TRANSITIONS[currentRide.status] || [];
  if (!allowedTransitions.includes(status)) {
    throw new Error(`Invalid status transition: ${currentRide.status} -> ${status}`);
  }
  
  // Validate that ride has a driver for driver-dependent statuses
  const driverRequiredStatuses = ['CONFIRMED', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'RIDE_COMPLETED'];
  if (driverRequiredStatuses.includes(status) && !currentRide.driverId) {
    throw new Error(`Cannot set status to ${status} without an assigned driver`);
  }
  
  const updateData: any = { status };
  if (status === 'RIDE_STARTED') updateData.startedAt = new Date();
  if (status === 'RIDE_COMPLETED') {
    updateData.completedAt = new Date();
    updateData.paymentStatus = 'PAID'; // Mark as paid when completed
  }
  if (status === 'CANCELLED') {
    updateData.cancelledAt = new Date();
    updateData.cancellationReason = cancellationReason;
  }
  
  // CRITICAL FIX: For RIDE_COMPLETED, wrap status update AND earnings creation in a single transaction
  // This ensures data consistency - ride is only marked completed if earnings are also created
  let ride: any;
  
  if (status === 'RIDE_COMPLETED' && currentRide.driverId) {
    // Get platform fee rate from config BEFORE transaction (default 20%)
    let commissionRate = 0.20;
    try {
      const platformFeeConfig = await prisma.platformConfig.findUnique({
        where: { key: 'platform_fee_rate' },
      });
      if (platformFeeConfig) {
        commissionRate = parseFloat(platformFeeConfig.value);
      }
    } catch (configError) {
      logger.warn(`[EARNINGS] Failed to fetch platform_fee_rate config, using default 20%`, { error: configError });
    }
    
    // Check if earnings already exist to prevent duplicates
    const existingEarning = await prisma.driverEarning.findUnique({
      where: { rideId },
    });
    
    if (existingEarning) {
      logger.warn(`[EARNINGS] Earnings already exist for ride ${rideId}, updating status only`);
      // Just update the ride status if earnings already exist
      ride = await prisma.ride.update({
        where: { id: rideId },
        data: updateData,
        include: {
          driver: {
            include: {
              user: { select: { firstName: true, lastName: true, profileImage: true, phone: true } },
            },
          },
        },
      });
    } else {
      // ATOMIC TRANSACTION: Update ride status AND create earnings together
      ride = await prisma.$transaction(async (tx) => {
        // Step 1: Update ride status
        const updatedRide = await tx.ride.update({
          where: { id: rideId },
          data: updateData,
          include: {
            driver: {
              include: {
                user: { select: { firstName: true, lastName: true, profileImage: true, phone: true } },
              },
            },
          },
        });
        
        // Step 2: Calculate earnings
        const commission = updatedRide.totalFare * commissionRate;
        const netAmount = updatedRide.totalFare - commission;
        const surgeFare = updatedRide.surgeMultiplier > 1
          ? (updatedRide.baseFare + updatedRide.distanceFare + updatedRide.timeFare) * (updatedRide.surgeMultiplier - 1)
          : 0;
        
        // Step 3: Create earnings record
        await tx.driverEarning.create({
          data: {
            driverId: updatedRide.driverId!,
            rideId: updatedRide.id,
            amount: updatedRide.totalFare,
            commission,
            commissionRate,
            netAmount,
            baseFare: updatedRide.baseFare,
            distanceFare: updatedRide.distanceFare,
            timeFare: updatedRide.timeFare,
            surgeFare: surgeFare,
          },
        });
        
        // Step 4: Update driver stats
        await tx.driver.update({
          where: { id: updatedRide.driverId! },
          data: {
            totalRides: { increment: 1 },
            totalEarnings: { increment: netAmount },
          },
        });
        
        logger.info(`[EARNINGS] ATOMIC: Ride ${rideId} completed with earnings ₹${netAmount.toFixed(2)} (commission: ₹${commission.toFixed(2)} at ${(commissionRate * 100).toFixed(0)}%)`);
        
        return updatedRide;
      }, {
        timeout: 15000, // 15 second timeout for the transaction
      });
    }
  } else {
    // For non-completion statuses, just update the ride
    ride = await prisma.ride.update({
      where: { id: rideId },
      data: updateData,
      include: {
        driver: {
          include: {
            user: { select: { firstName: true, lastName: true, profileImage: true, phone: true } },
          },
        },
      },
    });
  }
  
  try {
    await broadcastRideStatusUpdate(rideId, status);
  } catch (e) {
    logger.error('Broadcast ride status failed', { error: e });
  }
  
  // ==================== SEND NOTIFICATIONS FOR ALL STATUS CHANGES ====================
  try {
    // Get ride details for notifications
    const rideDetails = await prisma.ride.findUnique({
      where: { id: rideId },
      include: {
        driver: {
          include: {
            user: { select: { firstName: true, lastName: true, id: true } },
          },
        },
        passenger: { select: { firstName: true, lastName: true } },
      },
    });

    if (rideDetails) {
      const passengerName = `${rideDetails.passenger.firstName} ${rideDetails.passenger.lastName || ''}`.trim();
      const driverName = rideDetails.driver?.user 
        ? `${rideDetails.driver.user.firstName} ${rideDetails.driver.user.lastName || ''}`.trim()
        : 'Driver';
      const driverUserId = rideDetails.driver?.user?.id;

      switch (status) {
        case 'CONFIRMED':
          // Notify passenger that driver confirmed the ride
          await createNotification({
            userId: rideDetails.passengerId,
            title: 'Ride Confirmed',
            message: `${driverName} has confirmed your ride. They are on their way!`,
            type: 'RIDE_UPDATE',
            data: { rideId, event: 'RIDE_CONFIRMED' },
          });
          break;

        case 'DRIVER_ARRIVED':
          // Notify passenger that driver has arrived - include OTP!
          await createNotification({
            userId: rideDetails.passengerId,
            title: 'Driver Arrived',
            message: `${driverName} has arrived at your pickup location. Share OTP: ${rideDetails.rideOtp} to start the ride.`,
            type: 'RIDE_UPDATE',
            data: { rideId, event: 'DRIVER_ARRIVED', otp: rideDetails.rideOtp },
          });
          // Send rich push notification with OTP
          sendRidePushNotification(rideDetails.passengerId, 'DRIVER_ARRIVED', rideId, {
            driverName,
            otp: rideDetails.rideOtp,
          });
          break;

        case 'RIDE_STARTED':
          // Notify passenger that ride has started
          await createNotification({
            userId: rideDetails.passengerId,
            title: 'Ride Started',
            message: `Your ride to ${rideDetails.dropAddress} has started. Enjoy your journey!`,
            type: 'RIDE_UPDATE',
            data: { rideId, event: 'RIDE_STARTED' },
          });
          // Send rich push notification
          sendRidePushNotification(rideDetails.passengerId, 'RIDE_STARTED', rideId, {
            driverName,
            destination: rideDetails.dropAddress,
          });
          break;

        case 'RIDE_COMPLETED':
          // Notify passenger that ride is complete
          await createNotification({
            userId: rideDetails.passengerId,
            title: 'Ride Completed',
            message: `Your ride has been completed. Total fare: ₹${rideDetails.totalFare.toFixed(2)}. Please rate your experience!`,
            type: 'RIDE_UPDATE',
            data: { rideId, event: 'RIDE_COMPLETED', totalFare: rideDetails.totalFare },
          });
          // Send rich push notification to passenger
          sendRidePushNotification(rideDetails.passengerId, 'RIDE_COMPLETED_PASSENGER', rideId, {
            fare: rideDetails.totalFare,
            distance: rideDetails.distance,
          });
          
          // Notify driver that ride is complete
          if (driverUserId) {
            const netAmount = rideDetails.totalFare * 0.8; // Approximate, actual calculated above
            await createNotification({
              userId: driverUserId,
              title: 'Ride Completed',
              message: `Trip with ${passengerName} completed. You earned approximately ₹${netAmount.toFixed(2)}.`,
              type: 'RIDE_UPDATE',
              data: { rideId, event: 'RIDE_COMPLETED', totalFare: rideDetails.totalFare },
            });
            // Send rich push notification to driver
            sendRidePushNotification(driverUserId, 'RIDE_COMPLETED_DRIVER', rideId, {
              earnings: netAmount,
            });
          }
          break;

        case 'CANCELLED':
          // Notify both parties about cancellation
          const cancelledBy = rideDetails.cancelledBy || 'system';
          const cancelReason = rideDetails.cancellationReason || 'Ride was cancelled';
          
          await createNotification({
            userId: rideDetails.passengerId,
            title: 'Ride Cancelled',
            message: cancelledBy === 'passenger' 
              ? `Your ride has been cancelled. ${cancelReason}`
              : `Your ride was cancelled by the driver. ${cancelReason}`,
            type: 'RIDE_UPDATE',
            data: { rideId, event: 'RIDE_CANCELLED', cancelledBy, reason: cancelReason },
          });
          
          // Send push notification to passenger if cancelled by driver
          if (cancelledBy === 'driver') {
            sendRidePushNotification(rideDetails.passengerId, 'RIDE_CANCELLED_TO_PASSENGER', rideId, {
              driverName,
              reason: cancelReason,
            });
          }
          
          if (driverUserId) {
            await createNotification({
              userId: driverUserId,
              title: 'Ride Cancelled',
              message: cancelledBy === 'driver' 
                ? `You cancelled the ride with ${passengerName}. ${cancelReason}`
                : `${passengerName} has cancelled the ride. ${cancelReason}`,
              type: 'RIDE_UPDATE',
              data: { rideId, event: 'RIDE_CANCELLED', cancelledBy, reason: cancelReason },
            });
            
            // Send push notification to driver if cancelled by passenger
            if (cancelledBy === 'passenger') {
              sendRidePushNotification(driverUserId, 'RIDE_CANCELLED_TO_DRIVER', rideId, {
                passengerName,
                reason: cancelReason,
              });
            }
          }
          break;
      }
    }
  } catch (notificationError) {
    logger.error('[NOTIFICATION] Failed to send ride status notifications', { error: notificationError, rideId, status });
    // Don't fail the main operation for notification errors
  }
  
  return formatRide(ride);
}

export async function cancelRide(rideId: string, cancelledBy: 'passenger' | 'driver', reason?: string) {
  const ride = await prisma.ride.update({
    where: { id: rideId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy, // Store who cancelled the ride
      cancellationReason: reason || `Cancelled by ${cancelledBy}`,
    },
    include: {
      driver: {
        include: {
          user: { select: { id: true, firstName: true, lastName: true, profileImage: true, phone: true } },
        },
      },
      passenger: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  
  logger.info(`[RIDE_CANCEL] Ride ${rideId} cancelled by ${cancelledBy}${reason ? `: ${reason}` : ''}`);
  
  try {
    await broadcastRideCancelled(rideId, cancelledBy, reason);
  } catch (e) {
    logger.error('Broadcast ride cancelled failed', { error: e });
  }
  
  // Send cancellation notifications
  try {
    const passengerName = `${ride.passenger.firstName} ${ride.passenger.lastName || ''}`.trim();
    const driverName = ride.driver?.user 
      ? `${ride.driver.user.firstName} ${ride.driver.user.lastName || ''}`.trim()
      : 'Driver';
    const cancelReason = reason || 'Ride was cancelled';
    
    // Notify passenger
    await createNotification({
      userId: ride.passenger.id,
      title: 'Ride Cancelled',
      message: cancelledBy === 'passenger' 
        ? `Your ride has been cancelled. ${cancelReason}`
        : `Your ride was cancelled by ${driverName}. ${cancelReason}`,
      type: 'RIDE_UPDATE',
      data: { rideId, event: 'RIDE_CANCELLED', cancelledBy, reason: cancelReason },
    });
    
    // Send push notification to passenger if cancelled by driver
    if (cancelledBy === 'driver') {
      sendRidePushNotification(ride.passenger.id, 'RIDE_CANCELLED_TO_PASSENGER', rideId, {
        driverName,
        reason: cancelReason,
      });
    }
    
    // Notify driver if assigned
    if (ride.driver?.user?.id) {
      await createNotification({
        userId: ride.driver.user.id,
        title: 'Ride Cancelled',
        message: cancelledBy === 'driver' 
          ? `You cancelled the ride with ${passengerName}. ${cancelReason}`
          : `${passengerName} has cancelled the ride. ${cancelReason}`,
        type: 'RIDE_UPDATE',
        data: { rideId, event: 'RIDE_CANCELLED', cancelledBy, reason: cancelReason },
      });
      
      // Send push notification to driver if cancelled by passenger
      if (cancelledBy === 'passenger') {
        sendRidePushNotification(ride.driver.user.id, 'RIDE_CANCELLED_TO_DRIVER', rideId, {
          passengerName,
          reason: cancelReason,
        });
      }
    }
  } catch (notificationError) {
    logger.error('[NOTIFICATION] Failed to send cancellation notifications', { error: notificationError, rideId });
    // Don't fail the main operation
  }
  
  return formatRide(ride);
}

export async function getAvailableRidesForDriver(lat: number, lng: number, radiusKm: number, _driverId: string) {
  const pendingRides = await prisma.ride.findMany({
    where: { status: 'PENDING', driverId: null },
    include: {
      passenger: { select: { firstName: true, lastName: true, phone: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const filtered = pendingRides.filter((r) => calcDistance(lat, lng, r.pickupLatitude, r.pickupLongitude) <= radiusKm);
  // Driver does NOT get OTP in this list - they must get the 4-digit code from the passenger in person when starting the ride
  return filtered.map((ride) => ({
    id: ride.id,
    ride_type: 'cab',
    earning: ride.totalFare * 0.8,
    pickup_distance: `${calcDistance(lat, lng, ride.pickupLatitude, ride.pickupLongitude).toFixed(1)} km`,
    pickup_time: `${Math.ceil(calcDistance(lat, lng, ride.pickupLatitude, ride.pickupLongitude) * 3)} min`,
    drop_distance: `${ride.distance.toFixed(1)} km`,
    drop_time: `${Math.ceil(ride.duration / 60)} min`,
    pickup_address: ride.pickupAddress,
    drop_address: ride.dropAddress,
    pickup_location: { lat: ride.pickupLatitude, lng: ride.pickupLongitude },
    destination_location: { lat: ride.dropLatitude, lng: ride.dropLongitude },
    rider_name: ride.passenger ? `${ride.passenger.firstName} ${ride.passenger.lastName || ''}`.trim() : 'Passenger',
    rider_phone: ride.passenger?.phone || '',
    otp_required_at_start: true, // Driver must ask passenger for 4-digit code when starting ride
    is_golden: ride.totalFare > 500,
    created_at: ride.createdAt.toISOString(),
    total_fare: ride.totalFare,
  }));
}

export async function updateDriverLocation(driverId: string, lat: number, lng: number, heading?: number, speed?: number) {
  await prisma.driver.update({
    where: { id: driverId },
    data: { currentLatitude: lat, currentLongitude: lng, lastActiveAt: new Date() },
  });
  try {
    await updateDriverLocationRealtime(driverId, lat, lng, heading, speed);
  } catch (e) {
    logger.error('Realtime driver location update failed', { error: e });
  }
}

/**
 * Submit ride rating with idempotency, per-ride storage, correct average formula, and feedback storage.
 * 
 * Fixes:
 * - R1 (High): Uses ratingCount instead of totalRides for correct average
 * - R2 (High): Idempotent - prevents rating the same ride multiple times
 * - R3 (Medium): Stores feedback in the ride record
 * - R4 (Medium): Only allows the relevant party to rate
 * - R5 (Low): Returns updated driver rating after the update
 * - R6 (Low): Stores rating per ride
 */
export async function submitRideRating(
  rideId: string,
  rating: number,
  feedback: string | undefined,
  userId: string,
  raterRole: 'passenger' | 'driver'
) {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: { driver: true },
  });

  if (!ride) throw new Error('Ride not found');

  // Validate rating range
  if (rating < 1 || rating > 5) {
    throw new Error('Rating must be between 1 and 5');
  }

  // Only allow rating completed rides
  if (ride.status !== 'RIDE_COMPLETED') {
    throw new Error('Can only rate completed rides');
  }

  // Validate rater identity
  if (raterRole === 'passenger') {
    if (ride.passengerId !== userId) {
      throw new Error('You are not the passenger for this ride');
    }
    // Idempotency check: prevent re-rating
    if (ride.passengerRating !== null) {
      throw new Error('You have already rated this ride');
    }
    if (!ride.driverId) {
      throw new Error('Cannot rate a ride without a driver');
    }
  } else if (raterRole === 'driver') {
    // Driver rating the passenger (future feature)
    // For now, we verify the caller is the driver
    const driver = await prisma.driver.findUnique({ where: { userId } });
    if (!driver || driver.id !== ride.driverId) {
      throw new Error('You are not the driver for this ride');
    }
    if (ride.driverRating !== null) {
      throw new Error('You have already rated this ride');
    }
  }

  // Use transaction to ensure atomicity
  const result = await prisma.$transaction(async (tx) => {
    if (raterRole === 'passenger') {
      // Update ride with passenger's rating and feedback
      const updatedRide = await tx.ride.update({
        where: { id: rideId },
        data: {
          passengerRating: rating,
          passengerFeedback: feedback ?? null,
          ratedByPassengerAt: new Date(),
        },
      });

      // Update driver's rating with CORRECT formula using ratingCount
      const driver = await tx.driver.findUnique({ where: { id: ride.driverId! } });
      if (driver) {
        // Correct formula: use ratingCount (number of ratings) not totalRides (completed rides)
        const newRatingCount = driver.ratingCount + 1;
        const newAvg = ((driver.rating * driver.ratingCount) + rating) / newRatingCount;
        
        await tx.driver.update({
          where: { id: ride.driverId! },
          data: {
            rating: Math.round(newAvg * 10) / 10,
            ratingCount: newRatingCount,
          },
        });
      }

      return updatedRide;
    } else {
      // Driver rating passenger (future use)
      const updatedRide = await tx.ride.update({
        where: { id: rideId },
        data: {
          driverRating: rating,
          driverFeedback: feedback ?? null,
          ratedByDriverAt: new Date(),
        },
      });
      // Note: No passenger rating aggregation model exists yet
      return updatedRide;
    }
  });

  // Fetch updated ride with fresh driver data (including new rating)
  const updatedRide = await prisma.ride.findUnique({
    where: { id: rideId },
    include: {
      driver: {
        include: {
          user: { select: { firstName: true, lastName: true, profileImage: true, phone: true } },
        },
      },
    },
  });

  logger.info(`[RATING] ${raterRole} rated ride ${rideId}: ${rating} stars${feedback ? ` with feedback` : ''}`);

  return formatRide(updatedRide!);
}
