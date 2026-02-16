/**
 * StateSync — Async Database Persistence Layer
 * 
 * Bridges the in-memory state stores (Fireball/RAMEN) with PostgreSQL.
 * Handles:
 *   1. Hydration: Loading active state from DB on startup
 *   2. Persistence: Async batched writes from memory to DB
 *   3. Recovery: Detecting and resolving memory/DB inconsistencies
 * 
 * Consistency model: Eventual Consistency
 *   - In-memory state is the source of truth for active operations
 *   - DB is the source of truth for historical data and crash recovery
 *   - Writes are batched and flushed every 500ms-2s
 *   - On restart, active state is hydrated from DB
 */

import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import { rideStateStore, PendingDbWrite } from './rideStateStore';
import { driverStateStore, DriverDbWrite } from './driverStateStore';

const logger = createLogger('state-sync');

/**
 * Initialize the state sync layer:
 * 1. Register DB persistence callbacks with both stores
 * 2. Hydrate in-memory state from database
 */
export async function initializeStateSync(): Promise<void> {
  const startTime = Date.now();
  logger.info('[STATE-SYNC] ═══════════════════════════════════════════════════');
  logger.info('[STATE-SYNC] Initializing State Sync (Fireball + RAMEN)');
  logger.info('[STATE-SYNC] ═══════════════════════════════════════════════════');

  // ── 1. Register DB persistence callbacks ──────────────────────────────────

  rideStateStore.onDbSync(async (write: PendingDbWrite) => {
    await persistRideWrite(write);
  });

  driverStateStore.onDbSync(async (write: DriverDbWrite) => {
    await persistDriverWrite(write);
  });

  logger.info('[STATE-SYNC] DB persistence callbacks registered');

  // ── 2. Hydrate DriverStateStore from DB ───────────────────────────────────

  try {
    const activeDrivers = await prisma.driver.findMany({
      where: {
        isActive: true,
      },
      include: {
        user: {
          select: {
            firstName: true,
            lastName: true,
            phone: true,
            profileImage: true,
          },
        },
      },
    });

    driverStateStore.hydrateFromDb(activeDrivers);
    logger.info(`[STATE-SYNC] Hydrated ${activeDrivers.length} drivers into RAMEN`);
  } catch (error) {
    logger.error('[STATE-SYNC] Failed to hydrate drivers', { error });
  }

  // ── 3. Hydrate RideStateStore from DB ─────────────────────────────────────

  try {
    const activeRides = await prisma.ride.findMany({
      where: {
        status: {
          in: ['PENDING', 'DRIVER_ASSIGNED', 'CONFIRMED', 'DRIVER_ARRIVED', 'RIDE_STARTED'],
        },
      },
      include: {
        driver: {
          include: {
            user: {
              select: {
                firstName: true,
                lastName: true,
                phone: true,
                profileImage: true,
              },
            },
          },
        },
        passenger: {
          select: {
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    rideStateStore.hydrateFromDb(activeRides as any);
    logger.info(`[STATE-SYNC] Hydrated ${activeRides.length} active rides into Fireball`);
  } catch (error) {
    logger.error('[STATE-SYNC] Failed to hydrate rides', { error });
  }

  const elapsed = Date.now() - startTime;
  logger.info('[STATE-SYNC] ═══════════════════════════════════════════════════');
  logger.info(`[STATE-SYNC] State Sync initialized in ${elapsed}ms`);
  logger.info(`[STATE-SYNC] Fireball: ${rideStateStore.getMetrics().ridesInMemory} rides`);
  logger.info(`[STATE-SYNC] RAMEN:    ${driverStateStore.getMetrics().totalDrivers} drivers (${driverStateStore.getMetrics().onlineDrivers} online)`);
  logger.info('[STATE-SYNC] ═══════════════════════════════════════════════════');
}

// ─── Ride Persistence ─────────────────────────────────────────────────────────

async function persistRideWrite(write: PendingDbWrite): Promise<void> {
  try {
    switch (write.operation) {
      case 'create':
        // For ride creation, the ride-service already creates via Prisma.
        // This callback is for cases where Fireball creates rides directly.
        // In the current architecture, ride-service creates the DB record
        // and then notifies the realtime-service.
        logger.debug(`[STATE-SYNC] Ride create acknowledged: ${write.rideId}`);
        break;
        
      case 'status_change':
        await prisma.ride.update({
          where: { id: write.rideId },
          data: write.data,
        });
        logger.debug(`[STATE-SYNC] Ride status persisted: ${write.rideId} → ${write.data.status}`);
        break;
        
      case 'update':
        await prisma.ride.update({
          where: { id: write.rideId },
          data: write.data,
        });
        logger.debug(`[STATE-SYNC] Ride update persisted: ${write.rideId}`);
        break;
    }
  } catch (error) {
    logger.error(`[STATE-SYNC] Ride DB write failed: ${write.rideId}`, { error, operation: write.operation });
    throw error; // Re-throw so the store can retry
  }
}

// ─── Driver Persistence ───────────────────────────────────────────────────────

async function persistDriverWrite(write: DriverDbWrite): Promise<void> {
  try {
    switch (write.operation) {
      case 'location_update':
        await prisma.driver.update({
          where: { id: write.driverId },
          data: write.data,
        });
        break;
        
      case 'status_change':
        await prisma.driver.update({
          where: { id: write.driverId },
          data: write.data,
        });
        logger.debug(`[STATE-SYNC] Driver status persisted: ${write.driverId}`);
        break;
        
      case 'full_sync':
        await prisma.driver.update({
          where: { id: write.driverId },
          data: write.data,
        });
        break;
    }
  } catch (error) {
    logger.error(`[STATE-SYNC] Driver DB write failed: ${write.driverId}`, { error, operation: write.operation });
    throw error;
  }
}

/**
 * Graceful shutdown — flush all pending writes
 */
export async function shutdownStateSync(): Promise<void> {
  logger.info('[STATE-SYNC] Shutting down...');
  await rideStateStore.shutdown();
  await driverStateStore.shutdown();
  logger.info('[STATE-SYNC] Shutdown complete');
}
