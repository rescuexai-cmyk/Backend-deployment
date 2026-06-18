import { prisma } from '@raahi/shared';
import { createLogger, canDriverStartRides } from '@raahi/shared';
import {
  calculateFare,
  getNearbyBikeDrivers,
  getNearbyDriversFromDb,
  broadcastRescueRequest,
  broadcastRescueStatusUpdate,
  broadcastDriverAssigned,
  sendPushNotification,
} from './httpClients';

const logger = createLogger('rescue-service');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateRescueInput {
  userId: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  dropLat: number;
  dropLng: number;
  dropAddress: string;
  paymentMethod: 'CASH' | 'CARD' | 'UPI' | 'WALLET';
  hasVehicle: boolean;
  vehicleType?: 'TWO_WHEELER' | 'FOUR_WHEELER';
  vehicleDropAddress?: string;
  vehicleDropLat?: number;
  vehicleDropLng?: number;
  vehicleDropSameAsDrop?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Generate a 4-digit OTP for rescue verification
 */
function generateRescueOtp(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Get driver user ID from driver ID
 */
async function getDriverUserId(driverId: string): Promise<string | null> {
  try {
    const driver = await prisma.driver.findUnique({
      where: { id: driverId },
      select: { userId: true },
    });
    return driver?.userId || null;
  } catch (error) {
    logger.error(`Failed to get driver user ID for ${driverId}`, { error });
    return null;
  }
}

/**
 * Format rescue request for API response
 */
function formatRescueRequest(rescue: any) {
  return {
    id: rescue.id,
    userId: rescue.userId,
    
    // Pickup & Drop
    pickupAddress: rescue.pickupAddress,
    pickupLat: rescue.pickupLatitude,
    pickupLng: rescue.pickupLongitude,
    dropAddress: rescue.dropAddress,
    dropLat: rescue.dropLatitude,
    dropLng: rescue.dropLongitude,
    
    // Vehicle
    hasVehicle: rescue.hasVehicle,
    vehicleType: rescue.vehicleType,
    vehicleDropAddress: rescue.vehicleDropAddress,
    vehicleDropLat: rescue.vehicleDropLatitude,
    vehicleDropLng: rescue.vehicleDropLongitude,
    vehicleDropSameAsDrop: rescue.vehicleDropSameAsDrop,
    
    // Drivers
    driver1Id: rescue.driver1Id,
    driver2Id: rescue.driver2Id,
    driver1: rescue.driver1 ? {
      id: rescue.driver1.id,
      firstName: rescue.driver1.user?.firstName,
      lastName: rescue.driver1.user?.lastName,
      phone: rescue.driver1.user?.phone,
      profileImage: rescue.driver1.user?.profileImage,
      vehicleNumber: rescue.driver1.vehicleNumber,
      vehicleModel: rescue.driver1.vehicleModel,
      rating: rescue.driver1.rating,
    } : null,
    driver2: rescue.driver2 ? {
      id: rescue.driver2.id,
      firstName: rescue.driver2.user?.firstName,
      lastName: rescue.driver2.user?.lastName,
      phone: rescue.driver2.user?.phone,
      profileImage: rescue.driver2.user?.profileImage,
      vehicleNumber: rescue.driver2.vehicleNumber,
      vehicleModel: rescue.driver2.vehicleModel,
      rating: rescue.driver2.rating,
    } : null,
    
    // Rides
    userRideId: rescue.userRideId,
    vehicleRideId: rescue.vehicleRideId,
    
    // Status
    status: rescue.status,
    rescueStage: rescue.rescueStage,
    rescueOtp: rescue.rescueOtp, // Only sent to user (not drivers)
    paymentMethod: rescue.paymentMethod,
    
    // Timestamps
    driver1AcceptedAt: rescue.driver1AcceptedAt,
    driver2AcceptedAt: rescue.driver2AcceptedAt,
    driversEnRouteAt: rescue.driversEnRouteAt,
    driversArrivedAt: rescue.driversArrivedAt,
    startedAt: rescue.startedAt,
    completedAt: rescue.completedAt,
    cancelledAt: rescue.cancelledAt,
    cancelledBy: rescue.cancelledBy,
    cancellationReason: rescue.cancellationReason,
    createdAt: rescue.createdAt,
    updatedAt: rescue.updatedAt,
  };
}

// Include options for Prisma queries
const rescueInclude = {
  driver1: {
    include: {
      user: { select: { firstName: true, lastName: true, phone: true, profileImage: true } },
    },
  },
  driver2: {
    include: {
      user: { select: { firstName: true, lastName: true, phone: true, profileImage: true } },
    },
  },
  user: {
    select: { id: true, firstName: true, lastName: true, phone: true },
  },
};

// ─── Core Business Logic ──────────────────────────────────────────────────────

/**
 * Create a new rescue request
 * 
 * Flow:
 * 1. Validate input (if hasVehicle, require vehicleType)
 * 2. Create RescueRequest in DB
 * 3. Generate OTP
 * 4. Find nearby bike drivers
 * 5. Broadcast to drivers via realtime service
 */
export async function createRescueRequest(input: CreateRescueInput) {
  logger.info(`[RESCUE] ========== CREATE RESCUE REQUEST ==========`);
  logger.info(`[RESCUE] User: ${input.userId}`);
  logger.info(`[RESCUE] Pickup: ${input.pickupAddress} (${input.pickupLat}, ${input.pickupLng})`);
  logger.info(`[RESCUE] Drop: ${input.dropAddress} (${input.dropLat}, ${input.dropLng})`);
  logger.info(`[RESCUE] Has Vehicle: ${input.hasVehicle}, Type: ${input.vehicleType || 'N/A'}`);

  // Validate vehicle input
  if (input.hasVehicle) {
    if (!input.vehicleType) {
      throw new Error('Vehicle type is required when hasVehicle is true');
    }
    if (!['TWO_WHEELER', 'FOUR_WHEELER'].includes(input.vehicleType)) {
      throw new Error('Vehicle type must be TWO_WHEELER or FOUR_WHEELER');
    }
  }

  // Resolve vehicle drop location
  let vehicleDropLat = input.vehicleDropLat;
  let vehicleDropLng = input.vehicleDropLng;
  let vehicleDropAddress = input.vehicleDropAddress;
  const vehicleDropSameAsDrop = input.vehicleDropSameAsDrop || false;

  if (input.hasVehicle && vehicleDropSameAsDrop) {
    vehicleDropLat = input.dropLat;
    vehicleDropLng = input.dropLng;
    vehicleDropAddress = input.dropAddress;
  }

  if (input.hasVehicle && (!vehicleDropLat || !vehicleDropLng || !vehicleDropAddress)) {
    throw new Error('Vehicle drop location is required when hasVehicle is true');
  }

  // Generate OTP
  const rescueOtp = generateRescueOtp();
  logger.info(`[RESCUE] Generated OTP for rescue request`);

  // Calculate fare for user ride (rescue uses bike_rescue pricing)
  let fareEstimate: any;
  try {
    fareEstimate = await calculateFare({
      pickupLat: input.pickupLat,
      pickupLng: input.pickupLng,
      dropLat: input.dropLat,
      dropLng: input.dropLng,
      vehicleType: 'bike_rescue',
    });
    logger.info(`[RESCUE] User ride fare estimate: ₹${fareEstimate.totalFare}`);
  } catch (fareError) {
    logger.warn('[RESCUE] Fare calculation failed, continuing without estimate', { error: (fareError as Error).message });
  }

  // Create rescue request in DB
  const rescue = await (prisma as any).rescueRequest.create({
    data: {
      userId: input.userId,
      pickupAddress: input.pickupAddress,
      pickupLatitude: input.pickupLat,
      pickupLongitude: input.pickupLng,
      dropAddress: input.dropAddress,
      dropLatitude: input.dropLat,
      dropLongitude: input.dropLng,
      hasVehicle: input.hasVehicle,
      vehicleType: input.hasVehicle ? input.vehicleType : null,
      vehicleDropAddress: input.hasVehicle ? vehicleDropAddress : null,
      vehicleDropLatitude: input.hasVehicle ? vehicleDropLat : null,
      vehicleDropLongitude: input.hasVehicle ? vehicleDropLng : null,
      vehicleDropSameAsDrop,
      paymentMethod: input.paymentMethod,
      rescueOtp,
      status: 'PENDING',
      rescueStage: 0,
    },
    include: rescueInclude,
  });

  logger.info(`[RESCUE] Created rescue request: ${rescue.id}`);

  // Update user's last known location
  await prisma.user.update({
    where: { id: input.userId },
    data: {
      lastLatitude: input.pickupLat,
      lastLongitude: input.pickupLng,
      lastLocationAt: new Date(),
    },
  }).catch(err => {
    logger.warn(`[RESCUE] Failed to update user location: ${err.message}`);
  });

  // Find nearby bike drivers
  let nearbyDrivers = await getNearbyBikeDrivers(input.pickupLat, input.pickupLng, 10);
  
  if (!nearbyDrivers || nearbyDrivers.length === 0) {
    logger.info('[RESCUE] RAMEN unavailable, falling back to DB query...');
    nearbyDrivers = await getNearbyDriversFromDb(input.pickupLat, input.pickupLng, 10);
  } else {
    logger.info(`[RESCUE] ✅ Got ${nearbyDrivers.length} bike drivers from RAMEN`);
  }

  // Fallback to all online bike drivers if no nearby found
  if (!nearbyDrivers || nearbyDrivers.length === 0) {
    logger.warn('[RESCUE] [FALLBACK] No nearby bike drivers found, querying all online bike drivers');
    const onlineDrivers = await prisma.driver.findMany({
      where: {
        isOnline: true,
        isActive: true,
        isVerified: true,
        vehicleType: { in: ['bike', 'bike_rescue', 'motorbike'] },
      },
      select: { id: true, vehicleType: true },
      take: 200,
    });
    nearbyDrivers = onlineDrivers;
    logger.warn(`[RESCUE] [FALLBACK] Found ${nearbyDrivers.length} online bike drivers`);
  }

  const driverIds = Array.from(new Set((nearbyDrivers || []).map((d: { id: string }) => d.id)));
  logger.info(`[RESCUE] Broadcasting to ${driverIds.length} bike drivers`);

  // Broadcast rescue request to drivers
  try {
    const driversNeeded = input.hasVehicle ? 2 : 1;
    const broadcastResult = await broadcastRescueRequest(rescue.id, {
      id: rescue.id,
      pickupLatitude: input.pickupLat,
      pickupLongitude: input.pickupLng,
      dropLatitude: input.dropLat,
      dropLongitude: input.dropLng,
      pickupAddress: input.pickupAddress,
      dropAddress: input.dropAddress,
      totalFare: fareEstimate?.totalFare || 0,
      vehicleType: 'bike_rescue',
      passengerName: 'Rescue User',
      rideType: 'RESCUE',
      rescueMultiDriver: input.hasVehicle,
      driversNeeded,
      hasVehicle: input.hasVehicle,
      userVehicleType: input.vehicleType,
      vehicleDropAddress: vehicleDropAddress,
    }, driverIds);

    if (broadcastResult) {
      logger.info(`[RESCUE] Broadcast result: success=${broadcastResult.success}, targeted=${broadcastResult.targetedDrivers}`);
      if (!broadcastResult.success) {
        logger.error(`[RESCUE] 🚨 Rescue ${rescue.id} was NOT delivered to ANY driver!`);
      }
    }
  } catch (broadcastError) {
    logger.error(`[RESCUE] Broadcast failed for rescue ${rescue.id}`, { error: broadcastError });
  }

  logger.info(`[RESCUE] ========== CREATE RESCUE COMPLETE ==========`);

  return formatRescueRequest(rescue);
}

/**
 * Driver accepts a rescue request
 * 
 * Flow:
 * - No Vehicle: single driver → stage 0→2 (BOTH_ACCEPTED)
 * - Has Vehicle: 
 *   - First driver → stage 0→1 (DRIVER1_ACCEPTED)
 *   - Second driver → stage 1→2 (BOTH_ACCEPTED), pair drivers
 */
export async function driverAcceptRescue(rescueId: string, driverId: string) {
  logger.info(`[RESCUE] ========== DRIVER ACCEPT ==========`);
  logger.info(`[RESCUE] Rescue: ${rescueId}, Driver: ${driverId}`);

  // Get current rescue state with optimistic locking
  const rescue = await (prisma as any).rescueRequest.findUnique({
    where: { id: rescueId },
    include: rescueInclude,
  });

  if (!rescue) {
    throw new Error('Rescue request not found');
  }

  if (rescue.status === 'CANCELLED') {
    throw new Error('Rescue request has been cancelled');
  }

  if (rescue.status === 'COMPLETED') {
    throw new Error('Rescue request is already completed');
  }

  // Check driver is valid
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { 
      id: true, isOnline: true, isActive: true, isVerified: true, 
      onboardingStatus: true, vehicleType: true,
      user: { select: { firstName: true, lastName: true, phone: true, profileImage: true } },
    },
  });

  if (!driver) {
    throw new Error('Driver not found');
  }

  if (!canDriverStartRides(driver)) {
    throw new Error('Driver is not verified to accept rescue requests');
  }

  // Prevent same driver from accepting both slots
  if (rescue.driver1Id === driverId || rescue.driver2Id === driverId) {
    throw new Error('You have already accepted this rescue request');
  }

  const driverName = `${driver.user?.firstName || ''} ${driver.user?.lastName || ''}`.trim();
  const driverUserId = await getDriverUserId(driverId);

  // ─── No Vehicle: Single Driver Flow ──────────────────────────────────────
  if (!rescue.hasVehicle) {
    if (rescue.status !== 'PENDING') {
      throw new Error('This rescue request has already been accepted');
    }

    const updated = await (prisma as any).rescueRequest.update({
      where: { id: rescueId },
      data: {
        driver1Id: driverId,
        status: 'BOTH_ACCEPTED',
        rescueStage: 2,
        driver1AcceptedAt: new Date(),
      },
      include: rescueInclude,
    });

    logger.info(`[RESCUE] ✅ Single driver ${driverId} accepted rescue ${rescueId}`);

    // Notify user
    sendPushNotification(rescue.userId, 'Rescue Driver Assigned!', 
      `${driverName} is on the way to rescue you! Your rescue PIN: ${rescue.rescueOtp}`, {
        type: 'RESCUE_UPDATE',
        rescueId,
        event: 'DRIVER_ACCEPTED',
        otp: rescue.rescueOtp,
      });

    // Broadcast update
    broadcastDriverAssigned(rescueId, {
      id: driver.id,
      name: driverName,
      phone: driver.user?.phone,
      vehicleNumber: (driver as any).vehicleNumber,
      vehicleModel: (driver as any).vehicleModel,
      rating: (driver as any).rating,
      profileImage: driver.user?.profileImage,
      role: 'PRIMARY',
    }).catch(e => logger.warn('Broadcast driver assigned failed', { error: e }));

    return formatRescueRequest(updated);
  }

  // ─── Has Vehicle: Dual Driver Flow ───────────────────────────────────────

  if (rescue.status === 'PENDING') {
    // First driver accepts
    const updated = await (prisma as any).rescueRequest.update({
      where: { id: rescueId },
      data: {
        driver1Id: driverId,
        status: 'DRIVER1_ACCEPTED',
        rescueStage: 1,
        driver1AcceptedAt: new Date(),
      },
      include: rescueInclude,
    });

    logger.info(`[RESCUE] ✅ First driver ${driverId} accepted rescue ${rescueId} (waiting for second)`);

    // Notify user that first driver accepted
    sendPushNotification(rescue.userId, 'First Rescue Driver Assigned!',
      `${driverName} has accepted your rescue. Waiting for a second driver for your vehicle...`, {
        type: 'RESCUE_UPDATE',
        rescueId,
        event: 'DRIVER1_ACCEPTED',
      });

    // Continue broadcasting for second driver
    broadcastRescueStatusUpdate(rescueId, 'DRIVER1_ACCEPTED', {
      driver1Id: driverId,
      driver1Name: driverName,
      needsSecondDriver: true,
    }).catch(e => logger.warn('Broadcast status update failed', { error: e }));

    return formatRescueRequest(updated);

  } else if (rescue.status === 'DRIVER1_ACCEPTED') {
    // Second driver accepts
    const updated = await (prisma as any).rescueRequest.update({
      where: { id: rescueId },
      data: {
        driver2Id: driverId,
        status: 'BOTH_ACCEPTED',
        rescueStage: 2,
        driver2AcceptedAt: new Date(),
      },
      include: rescueInclude,
    });

    logger.info(`[RESCUE] ✅ Second driver ${driverId} accepted rescue ${rescueId} (both drivers ready)`);

    // Get driver 1 info for notifications
    const driver1UserId = await getDriverUserId(rescue.driver1Id);

    // Notify user that both drivers are ready
    sendPushNotification(rescue.userId, 'Both Rescue Drivers Ready!',
      `Both drivers are assigned! They will pick each other up and head to you. Your rescue PIN: ${rescue.rescueOtp}`, {
        type: 'RESCUE_UPDATE',
        rescueId,
        event: 'BOTH_ACCEPTED',
        otp: rescue.rescueOtp,
      });

    // Notify driver 1 about driver 2
    if (driver1UserId) {
      sendPushNotification(driver1UserId, 'Partner Driver Assigned!',
        `${driverName} will be your partner for this rescue. Pick them up and head to the user.`, {
          type: 'RESCUE_UPDATE',
          rescueId,
          event: 'PARTNER_ASSIGNED',
          partnerDriverId: driverId,
          partnerName: driverName,
        });
    }

    // Notify driver 2 about driver 1
    const driver1 = await prisma.driver.findUnique({
      where: { id: rescue.driver1Id },
      include: { user: { select: { firstName: true, lastName: true } } },
    });
    const driver1Name = driver1 ? `${driver1.user?.firstName || ''} ${driver1.user?.lastName || ''}`.trim() : 'Driver 1';

    if (driverUserId) {
      sendPushNotification(driverUserId, 'Partner Driver Assigned!',
        `${driver1Name} will pick you up and together you'll head to the rescue. Get ready!`, {
          type: 'RESCUE_UPDATE',
          rescueId,
          event: 'PARTNER_ASSIGNED',
          partnerDriverId: rescue.driver1Id,
          partnerName: driver1Name,
        });
    }

    // Broadcast both drivers assigned
    broadcastRescueStatusUpdate(rescueId, 'BOTH_ACCEPTED', {
      driver1Id: rescue.driver1Id,
      driver2Id: driverId,
    }).catch(e => logger.warn('Broadcast status update failed', { error: e }));

    return formatRescueRequest(updated);

  } else {
    throw new Error(`Cannot accept rescue request with status: ${rescue.status}`);
  }
}

/**
 * Driver 1 has picked up Driver 2, heading to user
 * Stage 2 → 3 (DRIVERS_EN_ROUTE)
 */
export async function driversEnRoute(rescueId: string, driverId: string) {
  logger.info(`[RESCUE] Drivers en route for rescue ${rescueId}`);

  const rescue = await (prisma as any).rescueRequest.findUnique({
    where: { id: rescueId },
  });

  if (!rescue) throw new Error('Rescue request not found');
  if (rescue.status !== 'BOTH_ACCEPTED') {
    throw new Error(`Cannot mark en-route from status: ${rescue.status}`);
  }

  // Only driver 1 (primary) can trigger this
  if (rescue.driver1Id !== driverId) {
    throw new Error('Only the primary driver can mark en-route');
  }

  const updated = await (prisma as any).rescueRequest.update({
    where: { id: rescueId },
    data: {
      status: 'DRIVERS_EN_ROUTE',
      rescueStage: 3,
      driversEnRouteAt: new Date(),
    },
    include: rescueInclude,
  });

  // Notify user
  sendPushNotification(rescue.userId, 'Rescue Drivers On The Way!',
    'Both drivers have teamed up and are heading to your location!', {
      type: 'RESCUE_UPDATE',
      rescueId,
      event: 'DRIVERS_EN_ROUTE',
    });

  broadcastRescueStatusUpdate(rescueId, 'DRIVERS_EN_ROUTE', {}).catch(e =>
    logger.warn('Broadcast en-route failed', { error: e }));

  return formatRescueRequest(updated);
}

/**
 * Drivers have arrived at user's pickup location
 * Stage 3 → 4 (DRIVERS_ARRIVED) or Stage 2 → 4 (single driver)
 */
export async function driversArrived(rescueId: string, driverId: string) {
  logger.info(`[RESCUE] Drivers arrived for rescue ${rescueId}`);

  const rescue = await (prisma as any).rescueRequest.findUnique({
    where: { id: rescueId },
  });

  if (!rescue) throw new Error('Rescue request not found');

  const allowedStatuses = ['BOTH_ACCEPTED', 'DRIVERS_EN_ROUTE'];
  if (!allowedStatuses.includes(rescue.status)) {
    throw new Error(`Cannot mark arrived from status: ${rescue.status}`);
  }

  // Either driver can mark arrived
  if (rescue.driver1Id !== driverId && rescue.driver2Id !== driverId) {
    throw new Error('Only assigned drivers can mark arrived');
  }

  const updated = await (prisma as any).rescueRequest.update({
    where: { id: rescueId },
    data: {
      status: 'DRIVERS_ARRIVED',
      rescueStage: 4,
      driversArrivedAt: new Date(),
    },
    include: rescueInclude,
  });

  // Notify user
  sendPushNotification(rescue.userId, 'Rescue Drivers Have Arrived!',
    `Your rescue team is here! Share your PIN: ${rescue.rescueOtp} with the driver.`, {
      type: 'RESCUE_UPDATE',
      rescueId,
      event: 'DRIVERS_ARRIVED',
      otp: rescue.rescueOtp,
    });

  broadcastRescueStatusUpdate(rescueId, 'DRIVERS_ARRIVED', {}).catch(e =>
    logger.warn('Broadcast arrived failed', { error: e }));

  return formatRescueRequest(updated);
}

/**
 * Verify rescue OTP and start rides
 * Stage 4 → 5 (IN_PROGRESS)
 * 
 * Creates actual Ride records:
 * - User Ride: Driver 1 takes user to drop
 * - Vehicle Ride (if hasVehicle): Driver 2 takes vehicle to vehicle drop
 */
export async function verifyOtpAndStartRides(rescueId: string, driverId: string, otp: string) {
  logger.info(`[RESCUE] ========== VERIFY OTP & START RIDES ==========`);
  logger.info(`[RESCUE] Rescue: ${rescueId}, Driver: ${driverId}`);

  const rescue = await (prisma as any).rescueRequest.findUnique({
    where: { id: rescueId },
    include: rescueInclude,
  });

  if (!rescue) throw new Error('Rescue request not found');
  if (rescue.status !== 'DRIVERS_ARRIVED') {
    throw new Error(`Cannot start rides from status: ${rescue.status}`);
  }

  // Only assigned drivers can verify OTP
  if (rescue.driver1Id !== driverId && rescue.driver2Id !== driverId) {
    throw new Error('Only assigned drivers can verify the OTP');
  }

  // Verify OTP
  if (rescue.rescueOtp !== otp) {
    logger.warn(`[RESCUE] Invalid OTP for rescue ${rescueId}`);
    throw new Error('Invalid OTP. Please ask the user for the correct rescue PIN.');
  }

  logger.info(`[RESCUE] ✅ OTP verified for rescue ${rescueId}`);

  // Create User Ride (Driver 1 → takes user to drop)
  let userRideId: string | null = null;
  try {
    const userRide = await prisma.ride.create({
      data: {
        passengerId: rescue.userId,
        driverId: rescue.driver1Id,
        pickupLatitude: rescue.pickupLatitude,
        pickupLongitude: rescue.pickupLongitude,
        dropLatitude: rescue.dropLatitude,
        dropLongitude: rescue.dropLongitude,
        pickupAddress: rescue.pickupAddress,
        dropAddress: rescue.dropAddress,
        distance: 0, // Will be calculated during ride
        duration: 0,
        baseFare: 0,
        distanceFare: 0,
        timeFare: 0,
        totalFare: 0,
        paymentMethod: rescue.paymentMethod as any,
        vehicleType: 'bike_rescue',
        status: 'RIDE_STARTED',
        rideType: 'RESCUE',
        rescueMultiDriver: rescue.hasVehicle,
        startedAt: new Date(),
        driverAssignedAt: rescue.driver1AcceptedAt,
        driverArrivedAt: rescue.driversArrivedAt,
        rideOtp: rescue.rescueOtp,
      },
    });
    userRideId = userRide.id;
    logger.info(`[RESCUE] Created user ride: ${userRideId}`);
  } catch (rideError) {
    logger.error('[RESCUE] Failed to create user ride', { error: rideError });
    throw new Error('Failed to create user ride');
  }

  // Create Vehicle Ride if hasVehicle (Driver 2 → takes vehicle to vehicle drop)
  let vehicleRideId: string | null = null;
  if (rescue.hasVehicle && rescue.driver2Id) {
    try {
      const vehicleRide = await prisma.ride.create({
        data: {
          passengerId: rescue.userId,
          driverId: rescue.driver2Id,
          pickupLatitude: rescue.pickupLatitude,
          pickupLongitude: rescue.pickupLongitude,
          dropLatitude: rescue.vehicleDropLatitude,
          dropLongitude: rescue.vehicleDropLongitude,
          pickupAddress: rescue.pickupAddress,
          dropAddress: rescue.vehicleDropAddress,
          distance: 0,
          duration: 0,
          baseFare: 0,
          distanceFare: 0,
          timeFare: 0,
          totalFare: 0,
          paymentMethod: rescue.paymentMethod as any,
          vehicleType: 'bike_rescue',
          status: 'RIDE_STARTED',
          rideType: 'RESCUE',
          rescueMultiDriver: true,
          startedAt: new Date(),
          driverAssignedAt: rescue.driver2AcceptedAt,
          driverArrivedAt: rescue.driversArrivedAt,
          rideOtp: rescue.rescueOtp,
        },
      });
      vehicleRideId = vehicleRide.id;
      logger.info(`[RESCUE] Created vehicle ride: ${vehicleRideId}`);
    } catch (rideError) {
      logger.error('[RESCUE] Failed to create vehicle ride', { error: rideError });
      // Non-fatal: user ride is already created
    }
  }

  // Update rescue request with ride IDs and status
  const updated = await (prisma as any).rescueRequest.update({
    where: { id: rescueId },
    data: {
      status: 'IN_PROGRESS',
      rescueStage: 5,
      startedAt: new Date(),
      userRideId,
      vehicleRideId,
    },
    include: rescueInclude,
  });

  // Notify user
  sendPushNotification(rescue.userId, 'Rescue Started!',
    rescue.hasVehicle
      ? 'Your rescue is underway! Track both your ride and your vehicle in the app.'
      : 'Your rescue ride has started! Track your ride in the app.', {
      type: 'RESCUE_UPDATE',
      rescueId,
      event: 'RIDES_STARTED',
      userRideId,
      vehicleRideId,
    });

  // Broadcast
  broadcastRescueStatusUpdate(rescueId, 'IN_PROGRESS', {
    userRideId,
    vehicleRideId,
  }).catch(e => logger.warn('Broadcast start failed', { error: e }));

  logger.info(`[RESCUE] ========== RIDES STARTED ==========`);

  return formatRescueRequest(updated);
}

/**
 * Complete a rescue request
 * Called when all linked rides are completed.
 * Stage 5 → 6 (COMPLETED)
 */
export async function completeRescue(rescueId: string) {
  logger.info(`[RESCUE] Completing rescue ${rescueId}`);

  const rescue = await (prisma as any).rescueRequest.findUnique({
    where: { id: rescueId },
  });

  if (!rescue) throw new Error('Rescue request not found');
  if (rescue.status !== 'IN_PROGRESS') {
    throw new Error(`Cannot complete rescue from status: ${rescue.status}`);
  }

  // Check if all rides are completed
  if (rescue.userRideId) {
    const userRide = await prisma.ride.findUnique({
      where: { id: rescue.userRideId },
      select: { status: true },
    });
    if (userRide && userRide.status !== 'RIDE_COMPLETED') {
      logger.info(`[RESCUE] User ride ${rescue.userRideId} still ${userRide.status}, not completing yet`);
      return null; // Not ready to complete
    }
  }

  if (rescue.vehicleRideId) {
    const vehicleRide = await prisma.ride.findUnique({
      where: { id: rescue.vehicleRideId },
      select: { status: true },
    });
    if (vehicleRide && vehicleRide.status !== 'RIDE_COMPLETED') {
      logger.info(`[RESCUE] Vehicle ride ${rescue.vehicleRideId} still ${vehicleRide.status}, not completing yet`);
      return null; // Not ready to complete
    }
  }

  const updated = await (prisma as any).rescueRequest.update({
    where: { id: rescueId },
    data: {
      status: 'COMPLETED',
      rescueStage: 6,
      completedAt: new Date(),
    },
    include: rescueInclude,
  });

  // Notify user
  sendPushNotification(rescue.userId, 'Rescue Completed!',
    rescue.hasVehicle
      ? 'Your rescue is complete! Both you and your vehicle have been delivered safely.'
      : 'Your rescue is complete! Thank you for using Raahi Rescue.', {
      type: 'RESCUE_UPDATE',
      rescueId,
      event: 'RESCUE_COMPLETED',
    });

  broadcastRescueStatusUpdate(rescueId, 'COMPLETED', {}).catch(e =>
    logger.warn('Broadcast complete failed', { error: e }));

  logger.info(`[RESCUE] ✅ Rescue ${rescueId} completed successfully`);

  return formatRescueRequest(updated);
}

/**
 * Cancel a rescue request
 */
export async function cancelRescue(
  rescueId: string, 
  cancelledBy: string, 
  reason?: string
) {
  logger.info(`[RESCUE] Cancelling rescue ${rescueId} by ${cancelledBy}`);

  const rescue = await (prisma as any).rescueRequest.findUnique({
    where: { id: rescueId },
  });

  if (!rescue) throw new Error('Rescue request not found');

  const terminalStatuses = ['COMPLETED', 'CANCELLED'];
  if (terminalStatuses.includes(rescue.status)) {
    throw new Error(`Cannot cancel rescue with status: ${rescue.status}`);
  }

  // Cancel linked rides if they exist
  const ridesToCancel = [rescue.userRideId, rescue.vehicleRideId].filter(Boolean);
  for (const rideId of ridesToCancel) {
    try {
      await prisma.ride.update({
        where: { id: rideId },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledBy,
          cancellationReason: reason || 'Rescue cancelled',
        },
      });
      logger.info(`[RESCUE] Cancelled linked ride ${rideId}`);
    } catch (cancelError) {
      logger.warn(`[RESCUE] Failed to cancel linked ride ${rideId}`, { error: cancelError });
    }
  }

  const updated = await (prisma as any).rescueRequest.update({
    where: { id: rescueId },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledBy,
      cancellationReason: reason,
    },
    include: rescueInclude,
  });

  // Notify relevant parties
  sendPushNotification(rescue.userId, 'Rescue Cancelled',
    reason || 'Your rescue request has been cancelled.', {
      type: 'RESCUE_UPDATE',
      rescueId,
      event: 'RESCUE_CANCELLED',
    });

  // Notify assigned drivers
  if (rescue.driver1Id) {
    const d1UserId = await getDriverUserId(rescue.driver1Id);
    if (d1UserId) {
      sendPushNotification(d1UserId, 'Rescue Cancelled', 
        'The rescue request has been cancelled.', {
          type: 'RESCUE_UPDATE', rescueId, event: 'RESCUE_CANCELLED',
        });
    }
  }
  if (rescue.driver2Id) {
    const d2UserId = await getDriverUserId(rescue.driver2Id);
    if (d2UserId) {
      sendPushNotification(d2UserId, 'Rescue Cancelled',
        'The rescue request has been cancelled.', {
          type: 'RESCUE_UPDATE', rescueId, event: 'RESCUE_CANCELLED',
        });
    }
  }

  broadcastRescueStatusUpdate(rescueId, 'CANCELLED', { cancelledBy, reason }).catch(e =>
    logger.warn('Broadcast cancel failed', { error: e }));

  return formatRescueRequest(updated);
}

/**
 * Get rescue request by ID
 */
export async function getRescueById(rescueId: string, requesterId?: string) {
  const rescue = await (prisma as any).rescueRequest.findUnique({
    where: { id: rescueId },
    include: rescueInclude,
  });

  if (!rescue) return null;

  const formatted = formatRescueRequest(rescue);

  // Only include OTP for the requesting user (not drivers)
  if (requesterId && requesterId !== rescue.userId) {
    formatted.rescueOtp = undefined as any;
  }

  return formatted;
}

/**
 * Get user's rescue history (paginated)
 */
export async function getUserRescueHistory(userId: string, page: number = 1, limit: number = 10) {
  const [rescues, total] = await Promise.all([
    (prisma as any).rescueRequest.findMany({
      where: { userId },
      include: rescueInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    (prisma as any).rescueRequest.count({ where: { userId } }),
  ]);

  return {
    rescues: rescues.map(formatRescueRequest),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

/**
 * Get progressive ride tracking for a rescue request
 * Returns status of both user ride and vehicle ride
 */
export async function getRescueProgress(rescueId: string) {
  const rescue = await (prisma as any).rescueRequest.findUnique({
    where: { id: rescueId },
    include: rescueInclude,
  });

  if (!rescue) return null;

  let userRide = null;
  let vehicleRide = null;

  if (rescue.userRideId) {
    userRide = await prisma.ride.findUnique({
      where: { id: rescue.userRideId },
      include: {
        driver: {
          include: {
            user: { select: { firstName: true, lastName: true, phone: true, profileImage: true } },
          },
        },
        tracking: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
    });
  }

  if (rescue.vehicleRideId) {
    vehicleRide = await prisma.ride.findUnique({
      where: { id: rescue.vehicleRideId },
      include: {
        driver: {
          include: {
            user: { select: { firstName: true, lastName: true, phone: true, profileImage: true } },
          },
        },
        tracking: {
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
    });
  }

  return {
    rescue: formatRescueRequest(rescue),
    userRide: userRide ? {
      id: userRide.id,
      status: userRide.status,
      pickupAddress: userRide.pickupAddress,
      dropAddress: userRide.dropAddress,
      driver: userRide.driver ? {
        id: userRide.driver.id,
        firstName: userRide.driver.user?.firstName,
        lastName: userRide.driver.user?.lastName,
        phone: userRide.driver.user?.phone,
        vehicleNumber: userRide.driver.vehicleNumber,
        vehicleModel: userRide.driver.vehicleModel,
      } : null,
      currentLocation: userRide.tracking?.[0] ? {
        lat: userRide.tracking[0].latitude,
        lng: userRide.tracking[0].longitude,
        heading: userRide.tracking[0].heading,
        speed: userRide.tracking[0].speed,
        timestamp: userRide.tracking[0].timestamp,
      } : null,
      startedAt: userRide.startedAt,
      completedAt: userRide.completedAt,
    } : null,
    vehicleRide: vehicleRide ? {
      id: vehicleRide.id,
      status: vehicleRide.status,
      pickupAddress: vehicleRide.pickupAddress,
      dropAddress: vehicleRide.dropAddress,
      driver: vehicleRide.driver ? {
        id: vehicleRide.driver.id,
        firstName: vehicleRide.driver.user?.firstName,
        lastName: vehicleRide.driver.user?.lastName,
        phone: vehicleRide.driver.user?.phone,
        vehicleNumber: vehicleRide.driver.vehicleNumber,
        vehicleModel: vehicleRide.driver.vehicleModel,
      } : null,
      currentLocation: vehicleRide.tracking?.[0] ? {
        lat: vehicleRide.tracking[0].latitude,
        lng: vehicleRide.tracking[0].longitude,
        heading: vehicleRide.tracking[0].heading,
        speed: vehicleRide.tracking[0].speed,
        timestamp: vehicleRide.tracking[0].timestamp,
      } : null,
      startedAt: vehicleRide.startedAt,
      completedAt: vehicleRide.completedAt,
    } : null,
  };
}

/**
 * Check and auto-complete rescue when all rides finish
 * Called by a webhook/callback when a ride status changes
 */
export async function checkAndCompleteRescue(rideId: string) {
  // Find rescue request that contains this ride
  const rescue = await (prisma as any).rescueRequest.findFirst({
    where: {
      OR: [
        { userRideId: rideId },
        { vehicleRideId: rideId },
      ],
      status: 'IN_PROGRESS',
    },
  });

  if (!rescue) return null;

  return completeRescue(rescue.id);
}
