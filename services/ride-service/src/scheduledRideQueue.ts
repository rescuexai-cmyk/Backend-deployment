import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import {
  normalizeVehicleType,
  getVehicleRank,
  isDriverCompatibleForRide,
} from '@raahi/shared';
import {
  broadcastRideRequest as httpBroadcastRideRequest,
  getNearbyDrivers as httpGetNearbyDrivers,
  getNearbyDriversFromMemory,
  registerRideInFireball,
} from './httpClients';

const logger = createLogger('scheduled-rides');

// ─── Configuration ───────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const PRE_ASSIGN_MINUTES = parseInt(process.env.SCHEDULE_PRE_ASSIGN_MINUTES || '10', 10);
const EXPIRE_MINUTES = parseInt(process.env.SCHEDULE_EXPIRE_MINUTES || '15', 10);
const SPILLOVER_DELAY_MS = parseInt(process.env.SPILLOVER_DELAY_MS || '15000', 10);

// Parse Redis URL into connection config for BullMQ
function parseRedisUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || 'redis',
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

const redisConnection = parseRedisUrl(REDIS_URL);

// ─── Queue & Worker ──────────────────────────────────────────────────────────

const QUEUE_NAME = 'scheduled-rides';

let scheduledRideQueue: Queue | null = null;
let scheduledRideWorker: Worker | null = null;

/**
 * Enqueue a scheduled ride for deferred dispatch.
 * The job fires at (scheduledAt - PRE_ASSIGN_MINUTES).
 */
export async function enqueueScheduledRide(rideId: string, scheduledAt: Date): Promise<void> {
  if (!scheduledRideQueue) {
    logger.error('[SCHEDULED] Queue not initialized, cannot enqueue ride');
    return;
  }

  const fireAt = new Date(scheduledAt.getTime() - PRE_ASSIGN_MINUTES * 60 * 1000);
  const delayMs = Math.max(0, fireAt.getTime() - Date.now());

  // Main dispatch job
  await scheduledRideQueue.add(
    'dispatch',
    { rideId, scheduledAt: scheduledAt.toISOString() },
    {
      jobId: `dispatch-${rideId}`,
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  // Expiry job: auto-cancel if no driver found EXPIRE_MINUTES after scheduledAt
  const expiryDelayMs = Math.max(0, scheduledAt.getTime() + EXPIRE_MINUTES * 60 * 1000 - Date.now());
  await scheduledRideQueue.add(
    'expire',
    { rideId, scheduledAt: scheduledAt.toISOString() },
    {
      jobId: `expire-${rideId}`,
      delay: expiryDelayMs,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );

  logger.info(`[SCHEDULED] Enqueued ride ${rideId}: dispatch in ${Math.round(delayMs / 1000)}s, expire in ${Math.round(expiryDelayMs / 1000)}s`);
}

/**
 * Cancel a scheduled ride's BullMQ jobs (called when user cancels).
 */
export async function cancelScheduledRideJob(rideId: string): Promise<void> {
  if (!scheduledRideQueue) return;

  try {
    const dispatchJob = await scheduledRideQueue.getJob(`dispatch-${rideId}`);
    if (dispatchJob) {
      await dispatchJob.remove();
      logger.info(`[SCHEDULED] Removed dispatch job for ride ${rideId}`);
    }

    const expireJob = await scheduledRideQueue.getJob(`expire-${rideId}`);
    if (expireJob) {
      await expireJob.remove();
      logger.info(`[SCHEDULED] Removed expire job for ride ${rideId}`);
    }
  } catch (err) {
    logger.warn(`[SCHEDULED] Failed to remove jobs for ride ${rideId}`, { error: err });
  }
}

// ─── Job Handlers ────────────────────────────────────────────────────────────

async function handleDispatch(job: Job): Promise<void> {
  const { rideId } = job.data;
  logger.info(`[SCHEDULED] ========== PROCESSING SCHEDULED RIDE ==========`);
  logger.info(`[SCHEDULED] Ride ID: ${rideId}`);

  // Fetch ride from DB
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    include: {
      passenger: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
  });

  if (!ride) {
    logger.warn(`[SCHEDULED] Ride ${rideId} not found — skipping`);
    return;
  }

  if (ride.status !== 'SCHEDULED') {
    logger.info(`[SCHEDULED] Ride ${rideId} is ${ride.status} (not SCHEDULED) — skipping`);
    return;
  }

  // Transition: SCHEDULED → PENDING
  await prisma.ride.update({
    where: { id: rideId },
    data: { status: 'PENDING' },
  });
  logger.info(`[SCHEDULED] Ride ${rideId} transitioned SCHEDULED → PENDING`);

  // Register in Fireball
  try {
    const { latLngToH3 } = require('@raahi/shared');
    await registerRideInFireball({
      id: ride.id,
      status: 'PENDING',
      passengerId: ride.passengerId,
      driverId: null,
      pickupLat: ride.pickupLatitude,
      pickupLng: ride.pickupLongitude,
      dropLat: ride.dropLatitude,
      dropLng: ride.dropLongitude,
      pickupAddress: ride.pickupAddress,
      dropAddress: ride.dropAddress,
      pickupH3: latLngToH3(ride.pickupLatitude, ride.pickupLongitude),
      totalFare: ride.totalFare,
      baseFare: ride.baseFare,
      distanceFare: ride.distanceFare,
      timeFare: ride.timeFare,
      surgeMultiplier: ride.surgeMultiplier,
      distance: ride.distance,
      duration: ride.duration,
      rideOtp: ride.rideOtp || '',
      paymentMethod: ride.paymentMethod,
      vehicleType: ride.vehicleType || 'cab',
      driverLat: null,
      driverLng: null,
      driverHeading: null,
      driverSpeed: null,
      createdAt: Date.now(),
      assignedAt: null,
      confirmedAt: null,
      arrivedAt: null,
      startedAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      passengerName: ride.passenger?.firstName || 'Passenger',
      driverName: null,
      driverPhone: null,
      driverVehicleNumber: null,
      driverVehicleModel: null,
      driverRating: null,
      driverProfileImage: null,
      rideType: (ride as any).rideType || 'NORMAL',
      rescueMultiDriver: (ride as any).rescueMultiDriver || false,
      rescueStage: (ride as any).rescueStage || 0,
      priority: 'NORMAL',
    });
  } catch (fireballError) {
    logger.debug('[SCHEDULED] Fireball registration failed (non-critical)', { error: fireballError });
  }

  // ─── Broadcast to drivers (same logic as createRide) ────────────────────
  const effectiveVehicleType = ride.vehicleType || 'cab';
  const rideRank = getVehicleRank(effectiveVehicleType);
  const isCabRide = normalizeVehicleType(effectiveVehicleType) === 'cab' && rideRank > 0;

  // Phase 1: same-tier drivers
  let nearbyDrivers = await getNearbyDriversFromMemory(ride.pickupLatitude, ride.pickupLongitude, 10, effectiveVehicleType);
  if (!nearbyDrivers || nearbyDrivers.length === 0) {
    nearbyDrivers = await httpGetNearbyDrivers(ride.pickupLatitude, ride.pickupLongitude, 10, effectiveVehicleType);
  }

  let filteredDrivers: typeof nearbyDrivers;
  if (isCabRide) {
    filteredDrivers = (nearbyDrivers || []).filter(
      (d: any) => getVehicleRank(d.vehicleType, d.serviceTypes) === rideRank && normalizeVehicleType(d.vehicleType) === 'cab',
    );
  } else {
    filteredDrivers = (nearbyDrivers || []).filter((d: any) =>
      isDriverCompatibleForRide(effectiveVehicleType, d.vehicleType, d.serviceTypes),
    );
  }

  // Fallback to all online drivers
  if (filteredDrivers.length === 0) {
    const onlineDrivers = await prisma.driver.findMany({
      where: { isOnline: true, isActive: true, isVerified: true },
      select: { id: true, vehicleType: true, serviceTypes: true },
      take: 200,
    });
    if (isCabRide) {
      filteredDrivers = onlineDrivers.filter(
        (d) => getVehicleRank(d.vehicleType, d.serviceTypes) === rideRank && normalizeVehicleType(d.vehicleType) === 'cab',
      );
    } else {
      filteredDrivers = onlineDrivers.filter((d) => isDriverCompatibleForRide(effectiveVehicleType, d.vehicleType, d.serviceTypes));
    }
  }

  const driverIds = Array.from(new Set(filteredDrivers.map((d: any) => d.id)));
  logger.info(`[SCHEDULED] Phase 1: ${driverIds.length} same-tier drivers for ride ${rideId}`);

  const broadcastResult = await httpBroadcastRideRequest(rideId, {
    id: ride.id,
    pickupLatitude: ride.pickupLatitude,
    pickupLongitude: ride.pickupLongitude,
    dropLatitude: ride.dropLatitude,
    dropLongitude: ride.dropLongitude,
    pickupAddress: ride.pickupAddress,
    dropAddress: ride.dropAddress,
    totalFare: ride.totalFare,
    vehicleType: effectiveVehicleType,
    passengerName: ride.passenger?.firstName || 'Passenger',
    rideType: (ride as any).rideType || 'NORMAL',
    rescueMultiDriver: (ride as any).rescueMultiDriver || false,
    rescueStage: 0,
    priority: 'NORMAL',
    isSpilloverTrip: false,
  }, driverIds);

  if (broadcastResult) {
    logger.info(`[SCHEDULED] Phase 1 broadcast: success=${broadcastResult.success}, targeted=${broadcastResult.targetedDrivers}`);
  }

  // Phase 2: spillover to higher-tier (delayed)
  if (isCabRide && rideRank < 3) {
    setTimeout(async () => {
      try {
        const currentRide = await prisma.ride.findUnique({
          where: { id: rideId },
          select: { status: true, driverId: true },
        });
        if (!currentRide || currentRide.status !== 'PENDING' || currentRide.driverId) return;

        let spilloverDrivers = await getNearbyDriversFromMemory(ride.pickupLatitude, ride.pickupLongitude, 10, effectiveVehicleType);
        if (!spilloverDrivers || spilloverDrivers.length === 0) {
          spilloverDrivers = await httpGetNearbyDrivers(ride.pickupLatitude, ride.pickupLongitude, 10, effectiveVehicleType);
        }

        let higherTier = (spilloverDrivers || []).filter(
          (d: any) => getVehicleRank(d.vehicleType, d.serviceTypes) > rideRank && normalizeVehicleType(d.vehicleType) === 'cab',
        );
        if (higherTier.length === 0) {
          const online = await prisma.driver.findMany({
            where: { isOnline: true, isActive: true, isVerified: true },
            select: { id: true, vehicleType: true, serviceTypes: true },
            take: 200,
          });
          higherTier = online.filter((d) => normalizeVehicleType(d.vehicleType) === 'cab' && getVehicleRank(d.vehicleType, d.serviceTypes) > rideRank);
        }

        const spilloverIds = Array.from(new Set(higherTier.map((d: any) => d.id)));
        if (spilloverIds.length === 0) return;

        logger.info(`[SCHEDULED] Phase 2 spillover: ${spilloverIds.length} higher-tier drivers`);
        await httpBroadcastRideRequest(rideId, {
          id: ride.id,
          pickupLatitude: ride.pickupLatitude,
          pickupLongitude: ride.pickupLongitude,
          dropLatitude: ride.dropLatitude,
          dropLongitude: ride.dropLongitude,
          pickupAddress: ride.pickupAddress,
          dropAddress: ride.dropAddress,
          totalFare: ride.totalFare,
          vehicleType: effectiveVehicleType,
          passengerName: ride.passenger?.firstName || 'Passenger',
          rideType: (ride as any).rideType || 'NORMAL',
          rescueMultiDriver: false,
          rescueStage: 0,
          priority: 'NORMAL',
          isSpilloverTrip: true,
          originalVehicleType: effectiveVehicleType,
        }, spilloverIds);
      } catch (err) {
        logger.error(`[SCHEDULED] Phase 2 spillover failed`, { error: err });
      }
    }, SPILLOVER_DELAY_MS);
  }

  logger.info(`[SCHEDULED] ========== SCHEDULED RIDE PROCESSING COMPLETE ==========`);
}

async function handleExpiry(job: Job): Promise<void> {
  const { rideId } = job.data;

  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { status: true, driverId: true },
  });

  if (!ride) return;

  // If ride is still PENDING or SCHEDULED with no driver, auto-cancel
  if ((ride.status === 'PENDING' || ride.status === 'SCHEDULED') && !ride.driverId) {
    await prisma.ride.update({
      where: { id: rideId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: 'system',
        cancellationReason: 'No driver found for scheduled ride',
      },
    });
    logger.info(`[SCHEDULED] Ride ${rideId} auto-cancelled: no driver found after expiry window`);

    // TODO: Send push notification to passenger about cancellation
  } else {
    logger.info(`[SCHEDULED] Ride ${rideId} is ${ride.status} with driver=${ride.driverId} — no expiry needed`);
  }
}

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the scheduled ride queue and worker.
 * Also recovers any scheduled rides that should have been processed while the service was down.
 */
export async function initScheduledRideWorker(): Promise<void> {
  try {
    scheduledRideQueue = new Queue(QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    });

    scheduledRideWorker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        if (job.name === 'dispatch') {
          await handleDispatch(job);
        } else if (job.name === 'expire') {
          await handleExpiry(job);
        } else {
          logger.warn(`[SCHEDULED] Unknown job name: ${job.name}`);
        }
      },
      {
        connection: redisConnection,
        concurrency: 5,
      },
    );

    scheduledRideWorker.on('completed', (job) => {
      logger.debug(`[SCHEDULED] Job ${job.id} completed`);
    });

    scheduledRideWorker.on('failed', (job, err) => {
      logger.error(`[SCHEDULED] Job ${job?.id} failed`, { error: err.message });
    });

    logger.info(`[SCHEDULED] ✅ BullMQ worker started (pre-assign=${PRE_ASSIGN_MINUTES}min, expire=${EXPIRE_MINUTES}min)`);

    // ─── Recovery: process any rides missed during downtime ──────────────
    await recoverMissedScheduledRides();
  } catch (err) {
    logger.error('[SCHEDULED] Failed to initialize BullMQ worker', { error: err });
    // Non-fatal: scheduled rides will be processed next time service restarts
  }
}

/**
 * On startup, find SCHEDULED rides whose dispatch time has already passed
 * and process them immediately.
 */
async function recoverMissedScheduledRides(): Promise<void> {
  try {
    const now = new Date();
    const preAssignWindow = new Date(now.getTime() + PRE_ASSIGN_MINUTES * 60 * 1000);

    // Find rides that should have been dispatched already
    const missedRides = await prisma.ride.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: { lte: preAssignWindow }, // scheduledAt - preAssign has passed
      },
      select: { id: true, scheduledAt: true },
    });

    if (missedRides.length === 0) {
      logger.info('[SCHEDULED] Recovery: no missed scheduled rides');
      return;
    }

    logger.warn(`[SCHEDULED] Recovery: found ${missedRides.length} missed scheduled rides — processing now`);

    for (const ride of missedRides) {
      // Add with zero delay to process immediately
      await scheduledRideQueue!.add(
        'dispatch',
        { rideId: ride.id, scheduledAt: ride.scheduledAt?.toISOString() },
        {
          jobId: `recovery-dispatch-${ride.id}`,
          delay: 0,
          removeOnComplete: true,
        },
      );
    }
  } catch (err) {
    logger.error('[SCHEDULED] Recovery failed', { error: err });
  }
}

/**
 * Graceful shutdown
 */
export async function shutdownScheduledRideWorker(): Promise<void> {
  if (scheduledRideWorker) {
    await scheduledRideWorker.close();
    logger.info('[SCHEDULED] Worker shut down');
  }
  if (scheduledRideQueue) {
    await scheduledRideQueue.close();
    logger.info('[SCHEDULED] Queue closed');
  }
}
