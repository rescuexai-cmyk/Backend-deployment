/**
 * RideStateStore — Redis-backed Ride State Machine
 * 
 * Migrated from in-memory Map to Redis for horizontal scaling.
 * All instances of realtime-service now share ride state.
 * 
 * Redis Data Structures:
 *   ride:{rideId}              → Hash with ride state
 *   passenger:ride:{passId}    → String mapping passengerId to active rideId
 *   driver:ride:{driverId}     → String mapping driverId to active rideId
 *   pending:rides              → Set of pending ride IDs
 * 
 * Falls back to in-memory if Redis is unavailable (single-instance mode).
 */

import { createLogger, getRedisClient, isRedisAvailable } from '@raahi/shared';
import { eventBus, CHANNELS } from './eventBus';

const logger = createLogger('ride-state-store');

// ─── Redis Keys ───────────────────────────────────────────────────────────────

const KEYS = {
  ride: (id: string) => `ride:${id}`,
  passengerRide: (passengerId: string) => `passenger:ride:${passengerId}`,
  driverRide: (driverId: string) => `driver:ride:${driverId}`,
  pendingRides: 'pending:rides',
};

// ─── Ride State Types ─────────────────────────────────────────────────────────

export type RideStatus = 
  | 'PENDING' 
  | 'DRIVER_ASSIGNED' 
  | 'CONFIRMED' 
  | 'DRIVER_ARRIVED' 
  | 'RIDE_STARTED' 
  | 'RIDE_COMPLETED' 
  | 'CANCELLED';

export interface RideState {
  id: string;
  status: RideStatus;
  passengerId: string;
  driverId: string | null;
  
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  pickupAddress: string;
  dropAddress: string;
  pickupH3: string;
  
  totalFare: number;
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeMultiplier: number;
  distance: number;
  duration: number;
  
  rideOtp: string;
  paymentMethod: string;
  vehicleType: string;
  
  driverLat: number | null;
  driverLng: number | null;
  driverHeading: number | null;
  driverSpeed: number | null;
  
  createdAt: number;
  assignedAt: number | null;
  confirmedAt: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  
  passengerName: string;
  driverName: string | null;
  driverPhone: string | null;
  driverVehicleNumber: string | null;
  driverVehicleModel: string | null;
  driverRating: number | null;
  driverProfileImage: string | null;
  
  _dirty: boolean;
  _lastSyncedAt: number;
  _version: number;
}

const VALID_TRANSITIONS: Record<RideStatus, RideStatus[]> = {
  'PENDING': ['DRIVER_ASSIGNED', 'CANCELLED'],
  'DRIVER_ASSIGNED': ['CONFIRMED', 'CANCELLED'],
  'CONFIRMED': ['DRIVER_ARRIVED', 'CANCELLED'],
  'DRIVER_ARRIVED': ['RIDE_STARTED', 'CANCELLED'],
  'RIDE_STARTED': ['RIDE_COMPLETED', 'CANCELLED'],
  'RIDE_COMPLETED': [],
  'CANCELLED': [],
};

// ─── State Change Event ───────────────────────────────────────────────────────

export interface RideStateChangeEvent {
  rideId: string;
  previousStatus: RideStatus;
  newStatus: RideStatus;
  timestamp: string;
  triggeredBy: string;
  state: Partial<RideState>;
}

// ─── Pending DB Write ─────────────────────────────────────────────────────────

export interface PendingDbWrite {
  rideId: string;
  operation: 'create' | 'update' | 'status_change';
  data: Record<string, any>;
  timestamp: number;
  retries: number;
}

// ─── Serialization ────────────────────────────────────────────────────────────

function serializeState(state: RideState): string {
  return JSON.stringify(state);
}

function deserializeState(json: string): RideState {
  return JSON.parse(json);
}

// ─── RideStateStore Implementation ────────────────────────────────────────────

class RideStateStoreImpl {
  // Fallback in-memory storage
  private localRides = new Map<string, RideState>();
  private localPassengerRides = new Map<string, string>();
  private localDriverRides = new Map<string, string>();
  private localPendingRides = new Set<string>();
  
  private writeQueue: PendingDbWrite[] = [];
  private dbSyncCallback: ((write: PendingDbWrite) => Promise<void>) | null = null;
  
  private flushInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  private readonly FLUSH_INTERVAL_MS = 500;
  private readonly COMPLETED_TTL_MS = 5 * 60 * 1000;
  private readonly CLEANUP_INTERVAL_MS = 60 * 1000;
  private readonly MAX_WRITE_RETRIES = 3;
  private readonly RIDE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

  private metrics = {
    totalStateChanges: 0,
    totalDbWrites: 0,
    totalDbWriteFailures: 0,
    avgStateChangeLatencyMs: 0,
    lastFlushAt: null as string | null,
  };

  private redisEnabled = false;

  constructor() {
    this.initRedis();
    this.startFlushLoop();
    this.startCleanupLoop();
    logger.info('[FIREBALL] RideStateStore initialized');
  }

  private async initRedis(): Promise<void> {
    const client = getRedisClient();
    if (client) {
      this.redisEnabled = true;
      logger.info('[FIREBALL] Redis mode enabled - horizontal scaling supported');
    } else {
      this.redisEnabled = false;
      logger.warn('[FIREBALL] Redis unavailable - falling back to in-memory (single instance only)');
    }
  }

  private useRedis(): boolean {
    return this.redisEnabled && isRedisAvailable();
  }

  // ─── Core State Operations ───────────────────────────────────────────────

  async createRide(ride: Omit<RideState, '_dirty' | '_lastSyncedAt' | '_version'>): Promise<RideState> {
    const now = Date.now();
    const state: RideState = {
      ...ride,
      _dirty: true,
      _lastSyncedAt: 0,
      _version: 1,
    };

    if (this.useRedis()) {
      const client = getRedisClient();
      const pipeline = client.pipeline();
      
      pipeline.setex(KEYS.ride(ride.id), this.RIDE_TTL_SECONDS, serializeState(state));
      pipeline.set(KEYS.passengerRide(ride.passengerId), ride.id);
      
      if (ride.status === 'PENDING') {
        pipeline.sadd(KEYS.pendingRides, ride.id);
      }
      
      await pipeline.exec();
    } else {
      this.localRides.set(ride.id, state);
      this.localPassengerRides.set(ride.passengerId, ride.id);
      
      if (ride.status === 'PENDING') {
        this.localPendingRides.add(ride.id);
      }
    }

    logger.info(`[FIREBALL] Ride created in memory: ${ride.id} (status: ${ride.status})`);

    eventBus.publish(CHANNELS.ride(ride.id), {
      type: 'ride-status-update',
      rideId: ride.id,
      status: ride.status,
      data: this.toPublicState(state),
      timestamp: new Date().toISOString(),
    });

    this.queueDbWrite({
      rideId: ride.id,
      operation: 'create',
      data: this.toDbData(state),
      timestamp: now,
      retries: 0,
    });

    this.metrics.totalStateChanges++;
    return state;
  }

  async transitionStatus(
    rideId: string,
    newStatus: RideStatus,
    triggeredBy: string,
    additionalData?: Partial<RideState>,
  ): Promise<RideState | null> {
    const startTime = performance.now();
    const state = await this.getRide(rideId);
    
    if (!state) {
      logger.warn(`[FIREBALL] Cannot transition: ride ${rideId} not found in memory`);
      return null;
    }

    const allowed = VALID_TRANSITIONS[state.status];
    if (!allowed.includes(newStatus)) {
      logger.warn(`[FIREBALL] Invalid transition: ${state.status} → ${newStatus} for ride ${rideId}`);
      return null;
    }

    const previousStatus = state.status;
    const now = Date.now();

    state.status = newStatus;
    state._dirty = true;
    state._version++;

    switch (newStatus) {
      case 'DRIVER_ASSIGNED':
        state.assignedAt = now;
        break;
      case 'CONFIRMED':
        state.confirmedAt = now;
        break;
      case 'DRIVER_ARRIVED':
        state.arrivedAt = now;
        break;
      case 'RIDE_STARTED':
        state.startedAt = now;
        break;
      case 'RIDE_COMPLETED':
        state.completedAt = now;
        break;
      case 'CANCELLED':
        state.cancelledAt = now;
        state.cancelledBy = additionalData?.cancelledBy || triggeredBy;
        state.cancellationReason = additionalData?.cancellationReason || null;
        break;
    }

    if (additionalData) {
      Object.assign(state, additionalData);
      state._dirty = true;
    }

    if (this.useRedis()) {
      const client = getRedisClient();
      const pipeline = client.pipeline();
      
      pipeline.setex(KEYS.ride(rideId), this.RIDE_TTL_SECONDS, serializeState(state));
      
      if (newStatus === 'DRIVER_ASSIGNED' && state.driverId) {
        pipeline.set(KEYS.driverRide(state.driverId), rideId);
        pipeline.srem(KEYS.pendingRides, rideId);
      }
      
      if (newStatus === 'RIDE_COMPLETED' || newStatus === 'CANCELLED') {
        pipeline.srem(KEYS.pendingRides, rideId);
        if (state.driverId) {
          pipeline.del(KEYS.driverRide(state.driverId));
        }
      }
      
      await pipeline.exec();
    } else {
      this.localRides.set(rideId, state);
      
      if (newStatus === 'DRIVER_ASSIGNED' && state.driverId) {
        this.localDriverRides.set(state.driverId, rideId);
        this.localPendingRides.delete(rideId);
      }
      
      if (newStatus === 'RIDE_COMPLETED' || newStatus === 'CANCELLED') {
        this.localPendingRides.delete(rideId);
        if (state.driverId) {
          this.localDriverRides.delete(state.driverId);
        }
      }
    }

    const latencyMs = performance.now() - startTime;
    this.metrics.totalStateChanges++;
    this.metrics.avgStateChangeLatencyMs = 
      (this.metrics.avgStateChangeLatencyMs * (this.metrics.totalStateChanges - 1) + latencyMs) 
      / this.metrics.totalStateChanges;

    logger.info(`[FIREBALL] State transition: ${rideId} ${previousStatus} → ${newStatus} (${latencyMs.toFixed(3)}ms in-memory)`);

    const timestamp = new Date().toISOString();

    eventBus.publish(CHANNELS.ride(rideId), {
      type: 'ride-status-update',
      rideId,
      status: newStatus,
      data: {
        ...this.toPublicState(state),
        previousStatus,
        triggeredBy,
      },
      timestamp,
    });

    if (newStatus === 'DRIVER_ASSIGNED' && state.driverId) {
      eventBus.publish(CHANNELS.ride(rideId), {
        type: 'driver-assigned',
        rideId,
        driver: {
          id: state.driverId,
          name: state.driverName,
          phone: state.driverPhone,
          vehicleNumber: state.driverVehicleNumber,
          vehicleModel: state.driverVehicleModel,
          rating: state.driverRating,
          profileImage: state.driverProfileImage,
        },
        timestamp,
      });

      eventBus.publish(CHANNELS.availableDrivers, {
        type: 'ride-status-update',
        rideId,
        status: 'TAKEN',
        data: { takenBy: state.driverId },
        timestamp,
      });
    }

    if (newStatus === 'CANCELLED') {
      eventBus.publish(CHANNELS.ride(rideId), {
        type: 'ride-cancelled',
        rideId,
        cancelledBy: state.cancelledBy || triggeredBy,
        reason: state.cancellationReason || undefined,
        timestamp,
      });
    }

    this.queueDbWrite({
      rideId,
      operation: 'status_change',
      data: {
        status: newStatus,
        ...(newStatus === 'DRIVER_ASSIGNED' ? { driverId: state.driverId, assignedAt: state.assignedAt } : {}),
        ...(newStatus === 'CONFIRMED' ? { confirmedAt: state.confirmedAt } : {}),
        ...(newStatus === 'DRIVER_ARRIVED' ? { arrivedAt: state.arrivedAt } : {}),
        ...(newStatus === 'RIDE_STARTED' ? { startedAt: new Date(state.startedAt!) } : {}),
        ...(newStatus === 'RIDE_COMPLETED' ? { completedAt: new Date(state.completedAt!), paymentStatus: 'PAID' } : {}),
        ...(newStatus === 'CANCELLED' ? { 
          cancelledAt: new Date(state.cancelledAt!), 
          cancelledBy: state.cancelledBy,
          cancellationReason: state.cancellationReason,
        } : {}),
      },
      timestamp: now,
      retries: 0,
    });

    return state;
  }

  async updateRideLocation(rideId: string, lat: number, lng: number, heading?: number, speed?: number): Promise<boolean> {
    const state = await this.getRide(rideId);
    if (!state) return false;

    state.driverLat = lat;
    state.driverLng = lng;
    state.driverHeading = heading ?? null;
    state.driverSpeed = speed ?? null;

    if (this.useRedis()) {
      await getRedisClient().setex(KEYS.ride(rideId), this.RIDE_TTL_SECONDS, serializeState(state));
    } else {
      this.localRides.set(rideId, state);
    }

    eventBus.publish(CHANNELS.ride(rideId), {
      type: 'driver-location',
      driverId: state.driverId || '',
      rideId,
      lat,
      lng,
      heading,
      speed,
      timestamp: new Date().toISOString(),
    });

    return true;
  }

  async verifyOtp(rideId: string, providedOtp: string): Promise<{ valid: boolean; error?: string }> {
    const state = await this.getRide(rideId);
    
    if (!state) {
      return { valid: false, error: 'Ride not found' };
    }
    if (state.status !== 'DRIVER_ARRIVED') {
      return { valid: false, error: `Cannot start ride with status: ${state.status}` };
    }
    if (state.rideOtp !== providedOtp) {
      return { valid: false, error: 'Invalid OTP' };
    }
    
    return { valid: true };
  }

  // ─── Query Methods ────────────────────────────────────────────────────────

  async getRide(rideId: string): Promise<RideState | null> {
    if (this.useRedis()) {
      const data = await getRedisClient().get(KEYS.ride(rideId));
      return data ? deserializeState(data) : null;
    }
    return this.localRides.get(rideId) || null;
  }

  async getPassengerActiveRide(passengerId: string): Promise<RideState | null> {
    let rideId: string | null = null;
    
    if (this.useRedis()) {
      rideId = await getRedisClient().get(KEYS.passengerRide(passengerId));
    } else {
      rideId = this.localPassengerRides.get(passengerId) || null;
    }
    
    if (!rideId) return null;
    
    const state = await this.getRide(rideId);
    if (!state) return null;
    
    if (['RIDE_COMPLETED', 'CANCELLED'].includes(state.status)) return null;
    return state;
  }

  async getDriverActiveRide(driverId: string): Promise<RideState | null> {
    let rideId: string | null = null;
    
    if (this.useRedis()) {
      rideId = await getRedisClient().get(KEYS.driverRide(driverId));
    } else {
      rideId = this.localDriverRides.get(driverId) || null;
    }
    
    if (!rideId) return null;
    return this.getRide(rideId);
  }

  async getPendingRides(): Promise<RideState[]> {
    const result: RideState[] = [];
    let pendingIds: string[] = [];
    
    if (this.useRedis()) {
      pendingIds = await getRedisClient().smembers(KEYS.pendingRides);
      
      if (pendingIds.length > 0) {
        const pipeline = getRedisClient().pipeline();
        for (const id of pendingIds) {
          pipeline.get(KEYS.ride(id));
        }
        
        const results = await pipeline.exec();
        for (const [err, data] of results || []) {
          if (!err && data) {
            const state = deserializeState(data as string);
            if (state.status === 'PENDING') {
              result.push(state);
            }
          }
        }
      }
    } else {
      for (const rideId of this.localPendingRides) {
        const state = this.localRides.get(rideId);
        if (state && state.status === 'PENDING') {
          result.push(state);
        }
      }
    }
    
    return result;
  }

  async getActiveRides(): Promise<RideState[]> {
    const active: RideState[] = [];
    
    if (this.useRedis()) {
      const client = getRedisClient();
      const keys = await client.keys('ride:*');
      
      if (keys.length > 0) {
        const pipeline = client.pipeline();
        for (const key of keys) {
          pipeline.get(key);
        }
        
        const results = await pipeline.exec();
        for (const [err, data] of results || []) {
          if (!err && data) {
            const state = deserializeState(data as string);
            if (!['RIDE_COMPLETED', 'CANCELLED'].includes(state.status)) {
              active.push(state);
            }
          }
        }
      }
    } else {
      for (const state of this.localRides.values()) {
        if (!['RIDE_COMPLETED', 'CANCELLED'].includes(state.status)) {
          active.push(state);
        }
      }
    }
    
    return active;
  }

  async hasRide(rideId: string): Promise<boolean> {
    if (this.useRedis()) {
      return (await getRedisClient().exists(KEYS.ride(rideId))) === 1;
    }
    return this.localRides.has(rideId);
  }

  // ─── Hydration ─────────────────────────────────────────────────────────────

  async hydrateFromDb(rides: Array<{
    id: string;
    status: string;
    passengerId: string;
    driverId: string | null;
    pickupLatitude: number;
    pickupLongitude: number;
    dropLatitude: number;
    dropLongitude: number;
    pickupAddress: string;
    dropAddress: string;
    totalFare: number;
    baseFare: number;
    distanceFare: number;
    timeFare: number;
    surgeMultiplier: number;
    distance: number;
    duration: number;
    rideOtp: string;
    paymentMethod: string;
    vehicleType: string | null;
    createdAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
    cancelledBy: string | null;
    cancellationReason: string | null;
    driver?: any;
    passenger?: any;
  }>): Promise<void> {
    const startTime = Date.now();
    const { latLngToH3 } = require('@raahi/shared');
    
    for (const ride of rides) {
      const state: RideState = {
        id: ride.id,
        status: ride.status as RideStatus,
        passengerId: ride.passengerId,
        driverId: ride.driverId,
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
        rideOtp: ride.rideOtp,
        paymentMethod: ride.paymentMethod,
        vehicleType: ride.vehicleType || 'SEDAN',
        driverLat: null,
        driverLng: null,
        driverHeading: null,
        driverSpeed: null,
        createdAt: ride.createdAt.getTime(),
        assignedAt: ride.driverId ? ride.createdAt.getTime() : null,
        confirmedAt: null,
        arrivedAt: null,
        startedAt: ride.startedAt?.getTime() || null,
        completedAt: ride.completedAt?.getTime() || null,
        cancelledAt: ride.cancelledAt?.getTime() || null,
        cancelledBy: ride.cancelledBy,
        cancellationReason: ride.cancellationReason,
        passengerName: ride.passenger 
          ? `${ride.passenger.firstName} ${ride.passenger.lastName || ''}`.trim()
          : 'Passenger',
        driverName: ride.driver?.user 
          ? `${ride.driver.user.firstName} ${ride.driver.user.lastName || ''}`.trim()
          : null,
        driverPhone: ride.driver?.user?.phone || null,
        driverVehicleNumber: ride.driver?.vehicleNumber || null,
        driverVehicleModel: ride.driver?.vehicleModel || null,
        driverRating: ride.driver?.rating || null,
        driverProfileImage: ride.driver?.user?.profileImage || null,
        _dirty: false,
        _lastSyncedAt: Date.now(),
        _version: 1,
      };

      if (this.useRedis()) {
        const client = getRedisClient();
        const pipeline = client.pipeline();
        
        pipeline.setex(KEYS.ride(ride.id), this.RIDE_TTL_SECONDS, serializeState(state));
        pipeline.set(KEYS.passengerRide(ride.passengerId), ride.id);
        
        if (ride.driverId) {
          pipeline.set(KEYS.driverRide(ride.driverId), ride.id);
        }
        if (ride.status === 'PENDING') {
          pipeline.sadd(KEYS.pendingRides, ride.id);
        }
        
        await pipeline.exec();
      } else {
        this.localRides.set(ride.id, state);
        this.localPassengerRides.set(ride.passengerId, ride.id);
        
        if (ride.driverId) {
          this.localDriverRides.set(ride.driverId, ride.id);
        }
        if (ride.status === 'PENDING') {
          this.localPendingRides.add(ride.id);
        }
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[FIREBALL] Hydrated ${rides.length} active rides from DB in ${elapsed}ms (redis=${this.useRedis()})`);
  }

  // ─── Async DB Persistence ────────────────────────────────────────────────

  onDbSync(callback: (write: PendingDbWrite) => Promise<void>): void {
    this.dbSyncCallback = callback;
  }

  private queueDbWrite(write: PendingDbWrite): void {
    this.writeQueue.push(write);
  }

  private startFlushLoop(): void {
    this.flushInterval = setInterval(async () => {
      if (this.writeQueue.length === 0) return;

      const batch = this.writeQueue.splice(0, this.writeQueue.length);
      this.metrics.lastFlushAt = new Date().toISOString();

      for (const write of batch) {
        try {
          if (this.dbSyncCallback) {
            await this.dbSyncCallback(write);
            this.metrics.totalDbWrites++;
            
            const state = await this.getRide(write.rideId);
            if (state) {
              state._dirty = false;
              state._lastSyncedAt = Date.now();
              
              if (this.useRedis()) {
                await getRedisClient().setex(KEYS.ride(write.rideId), this.RIDE_TTL_SECONDS, serializeState(state));
              }
            }
          }
        } catch (error) {
          this.metrics.totalDbWriteFailures++;
          write.retries++;
          
          if (write.retries < this.MAX_WRITE_RETRIES) {
            this.writeQueue.push(write);
            logger.warn(`[FIREBALL] DB write retry ${write.retries}/${this.MAX_WRITE_RETRIES} for ride ${write.rideId}`, { error });
          } else {
            logger.error(`[FIREBALL] DB write FAILED after ${this.MAX_WRITE_RETRIES} retries for ride ${write.rideId}`, { error });
          }
        }
      }
    }, this.FLUSH_INTERVAL_MS);
  }

  private startCleanupLoop(): void {
    this.cleanupInterval = setInterval(async () => {
      const now = Date.now();
      const toDelete: string[] = [];

      if (this.useRedis()) {
        const client = getRedisClient();
        const keys = await client.keys('ride:*');
        
        if (keys.length > 0) {
          const pipeline = client.pipeline();
          for (const key of keys) {
            pipeline.get(key);
          }
          
          const results = await pipeline.exec();
          for (let i = 0; i < (results?.length || 0); i++) {
            const [err, data] = results![i];
            if (!err && data) {
              const state = deserializeState(data as string);
              const isTerminal = state.status === 'RIDE_COMPLETED' || state.status === 'CANCELLED';
              const terminalTime = state.completedAt || state.cancelledAt || 0;
              
              if (isTerminal && (now - terminalTime) > this.COMPLETED_TTL_MS && !state._dirty) {
                toDelete.push(state.id);
              }
            }
          }
        }

        if (toDelete.length > 0) {
          const delPipeline = client.pipeline();
          for (const rideId of toDelete) {
            const state = await this.getRide(rideId);
            if (state) {
              delPipeline.del(KEYS.ride(rideId));
              delPipeline.del(KEYS.passengerRide(state.passengerId));
              if (state.driverId) {
                delPipeline.del(KEYS.driverRide(state.driverId));
              }
              delPipeline.srem(KEYS.pendingRides, rideId);
            }
          }
          await delPipeline.exec();
        }
      } else {
        for (const [rideId, state] of this.localRides) {
          const isTerminal = state.status === 'RIDE_COMPLETED' || state.status === 'CANCELLED';
          const terminalTime = state.completedAt || state.cancelledAt || 0;
          
          if (isTerminal && (now - terminalTime) > this.COMPLETED_TTL_MS && !state._dirty) {
            toDelete.push(rideId);
          }
        }

        for (const rideId of toDelete) {
          const state = this.localRides.get(rideId);
          if (state) {
            this.localPassengerRides.delete(state.passengerId);
            if (state.driverId) this.localDriverRides.delete(state.driverId);
            this.localPendingRides.delete(rideId);
            this.localRides.delete(rideId);
          }
        }
      }

      if (toDelete.length > 0) {
        logger.debug(`[FIREBALL] Cleaned up ${toDelete.length} terminated rides from memory`);
      }
    }, this.CLEANUP_INTERVAL_MS);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  toPublicState(state: RideState): Record<string, any> {
    const { _dirty, _lastSyncedAt, _version, rideOtp, ...publicFields } = state;
    return publicFields;
  }

  toPublicStateWithOtp(state: RideState): Record<string, any> {
    const { _dirty, _lastSyncedAt, _version, ...publicFields } = state;
    return publicFields;
  }

  private toDbData(state: RideState): Record<string, any> {
    return {
      id: state.id,
      status: state.status,
      passengerId: state.passengerId,
      driverId: state.driverId,
      pickupLatitude: state.pickupLat,
      pickupLongitude: state.pickupLng,
      dropLatitude: state.dropLat,
      dropLongitude: state.dropLng,
      pickupAddress: state.pickupAddress,
      dropAddress: state.dropAddress,
      totalFare: state.totalFare,
      baseFare: state.baseFare,
      distanceFare: state.distanceFare,
      timeFare: state.timeFare,
      surgeMultiplier: state.surgeMultiplier,
      distance: state.distance,
      duration: state.duration,
      rideOtp: state.rideOtp,
      paymentMethod: state.paymentMethod,
      vehicleType: state.vehicleType,
    };
  }

  // ─── Metrics ─────────────────────────────────────────────────────────────

  async getMetrics() {
    let ridesCount = 0;
    let pendingCount = 0;
    
    if (this.useRedis()) {
      const client = getRedisClient();
      const keys = await client.keys('ride:*');
      ridesCount = keys.length;
      pendingCount = await client.scard(KEYS.pendingRides);
    } else {
      ridesCount = this.localRides.size;
      pendingCount = this.localPendingRides.size;
    }
    
    return {
      ...this.metrics,
      ridesInMemory: ridesCount,
      pendingRides: pendingCount,
      redisEnabled: this.useRedis(),
      writeQueueSize: this.writeQueue.length,
    };
  }

  async shutdown(): Promise<void> {
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    if (this.writeQueue.length > 0 && this.dbSyncCallback) {
      logger.info(`[FIREBALL] Flushing ${this.writeQueue.length} pending DB writes on shutdown...`);
      for (const write of this.writeQueue) {
        try {
          await this.dbSyncCallback(write);
        } catch (error) {
          logger.error(`[FIREBALL] Failed to flush write for ride ${write.rideId} on shutdown`, { error });
        }
      }
    }

    logger.info('[FIREBALL] RideStateStore shut down');
  }
}

export const rideStateStore = new RideStateStoreImpl();
