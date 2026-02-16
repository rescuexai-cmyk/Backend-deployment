/**
 * RideStateStore — In-Memory Ride State Machine (Uber Fireball equivalent)
 * 
 * Uber's Fireball is their real-time dispatch system that manages ride state
 * entirely in memory, broadcasting state transitions instantly without 
 * waiting for database writes.
 * 
 * How it works:
 *   1. State changes happen in-memory FIRST (microseconds)
 *   2. Events are pushed to all subscribers INSTANTLY via EventBus
 *   3. Database persistence happens ASYNCHRONOUSLY (eventual consistency)
 *   4. On restart, state is hydrated from the database
 * 
 * Before (DB-polling):
 *   Client → REST → DB Write (50-200ms) → DB Read → Push → Client
 *   Total latency: 200-500ms + clients polling every 2-5s
 * 
 * After (Fireball):
 *   Client → REST → Memory Write (0.01ms) → Instant Push → Client
 *                                          → Async DB Write (background)
 *   Total latency: 1-5ms (100x faster)
 * 
 * State Machine:
 *   PENDING → DRIVER_ASSIGNED → CONFIRMED → DRIVER_ARRIVED → RIDE_STARTED → RIDE_COMPLETED
 *          ↓                  ↓           ↓                ↓
 *       CANCELLED          CANCELLED    CANCELLED        CANCELLED
 */

import { createLogger } from '@raahi/shared';
import { eventBus, CHANNELS } from './eventBus';

const logger = createLogger('ride-state-store');

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
  
  // Location data
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  pickupAddress: string;
  dropAddress: string;
  pickupH3: string;
  
  // Fare data
  totalFare: number;
  baseFare: number;
  distanceFare: number;
  timeFare: number;
  surgeMultiplier: number;
  distance: number;
  duration: number;
  
  // Verification
  rideOtp: string;
  paymentMethod: string;
  vehicleType: string;
  
  // Live tracking
  driverLat: number | null;
  driverLng: number | null;
  driverHeading: number | null;
  driverSpeed: number | null;
  
  // Timestamps
  createdAt: number;   // Unix ms
  assignedAt: number | null;
  confirmedAt: number | null;
  arrivedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  cancelledBy: string | null;
  cancellationReason: string | null;
  
  // Metadata
  passengerName: string;
  driverName: string | null;
  driverPhone: string | null;
  driverVehicleNumber: string | null;
  driverVehicleModel: string | null;
  driverRating: number | null;
  driverProfileImage: string | null;
  
  // Dirty flag for async DB sync
  _dirty: boolean;
  _lastSyncedAt: number;
  _version: number;  // Optimistic concurrency control
}

// Valid state transitions
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

// ─── RideStateStore Implementation ────────────────────────────────────────────

class RideStateStoreImpl {
  /** Active ride states keyed by rideId */
  private rides = new Map<string, RideState>();
  
  /** Passenger to active ride mapping (passengerId → rideId) */
  private passengerRides = new Map<string, string>();
  
  /** Driver to active ride mapping (driverId → rideId) */
  private driverRides = new Map<string, string>();
  
  /** Pending rides (PENDING status) for driver matching */
  private pendingRides = new Set<string>();
  
  /** Queue of DB writes to flush asynchronously */
  private writeQueue: PendingDbWrite[] = [];
  
  /** Callback for async DB persistence */
  private dbSyncCallback: ((write: PendingDbWrite) => Promise<void>) | null = null;
  
  /** Flush interval for batched DB writes */
  private flushInterval: NodeJS.Timeout | null = null;
  
  /** TTL cleanup interval for completed/cancelled rides */
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  // Configuration
  private readonly FLUSH_INTERVAL_MS = 500;   // Flush DB writes every 500ms
  private readonly COMPLETED_TTL_MS = 5 * 60 * 1000;  // Keep completed rides 5 min
  private readonly CLEANUP_INTERVAL_MS = 60 * 1000;    // Cleanup every 60s
  private readonly MAX_WRITE_RETRIES = 3;

  private metrics = {
    totalStateChanges: 0,
    totalDbWrites: 0,
    totalDbWriteFailures: 0,
    avgStateChangeLatencyMs: 0,
    lastFlushAt: null as string | null,
  };

  constructor() {
    this.startFlushLoop();
    this.startCleanupLoop();
    logger.info('[FIREBALL] RideStateStore initialized');
  }

  // ─── Core State Operations ───────────────────────────────────────────────

  /**
   * Create a new ride in memory and queue DB write.
   * Returns instantly — DB write happens in background.
   */
  createRide(ride: Omit<RideState, '_dirty' | '_lastSyncedAt' | '_version'>): RideState {
    const now = Date.now();
    const state: RideState = {
      ...ride,
      _dirty: true,
      _lastSyncedAt: 0,
      _version: 1,
    };

    this.rides.set(ride.id, state);
    this.passengerRides.set(ride.passengerId, ride.id);
    
    if (ride.status === 'PENDING') {
      this.pendingRides.add(ride.id);
    }

    logger.info(`[FIREBALL] Ride created in memory: ${ride.id} (status: ${ride.status})`);

    // Instant event push
    eventBus.publish(CHANNELS.ride(ride.id), {
      type: 'ride-status-update',
      rideId: ride.id,
      status: ride.status,
      data: this.toPublicState(state),
      timestamp: new Date().toISOString(),
    });

    // Queue async DB write
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

  /**
   * Transition ride to a new status.
   * Happens in memory instantly, pushes event, queues DB write.
   * 
   * @returns Updated state or null if transition invalid
   */
  transitionStatus(
    rideId: string,
    newStatus: RideStatus,
    triggeredBy: string,
    additionalData?: Partial<RideState>,
  ): RideState | null {
    const startTime = performance.now();
    const state = this.rides.get(rideId);
    
    if (!state) {
      logger.warn(`[FIREBALL] Cannot transition: ride ${rideId} not found in memory`);
      return null;
    }

    // Validate transition
    const allowed = VALID_TRANSITIONS[state.status];
    if (!allowed.includes(newStatus)) {
      logger.warn(`[FIREBALL] Invalid transition: ${state.status} → ${newStatus} for ride ${rideId}`);
      return null;
    }

    const previousStatus = state.status;
    const now = Date.now();

    // Apply state change IN MEMORY (microseconds)
    state.status = newStatus;
    state._dirty = true;
    state._version++;

    // Apply timestamps
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
        this.pendingRides.delete(rideId);
        break;
      case 'CANCELLED':
        state.cancelledAt = now;
        state.cancelledBy = additionalData?.cancelledBy || triggeredBy;
        state.cancellationReason = additionalData?.cancellationReason || null;
        this.pendingRides.delete(rideId);
        break;
    }

    // Apply additional data (driver info, etc.)
    if (additionalData) {
      Object.assign(state, additionalData);
      // Reset dirty fields
      state._dirty = true;
    }

    // Update index mappings
    if (newStatus === 'DRIVER_ASSIGNED' && state.driverId) {
      this.driverRides.set(state.driverId, rideId);
    }
    if (newStatus === 'RIDE_COMPLETED' || newStatus === 'CANCELLED') {
      if (state.driverId) {
        this.driverRides.delete(state.driverId);
      }
      // Don't delete from passengerRides yet — passenger might need to rate
    }

    const latencyMs = performance.now() - startTime;
    this.metrics.totalStateChanges++;
    this.metrics.avgStateChangeLatencyMs = 
      (this.metrics.avgStateChangeLatencyMs * (this.metrics.totalStateChanges - 1) + latencyMs) 
      / this.metrics.totalStateChanges;

    logger.info(`[FIREBALL] State transition: ${rideId} ${previousStatus} → ${newStatus} (${latencyMs.toFixed(3)}ms in-memory)`);

    // ── INSTANT EVENT PUSH (0ms latency to clients) ────────────────────────
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

    // Special events for specific transitions
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

      // Notify available drivers that this ride is taken
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

    // ── Queue async DB write ───────────────────────────────────────────────
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

  /**
   * Update driver location for an active ride — ZERO DB writes.
   * Location is stored in memory, pushed to clients instantly.
   * DB sync happens in the batched flush loop.
   */
  updateRideLocation(rideId: string, lat: number, lng: number, heading?: number, speed?: number): boolean {
    const state = this.rides.get(rideId);
    if (!state) return false;

    state.driverLat = lat;
    state.driverLng = lng;
    state.driverHeading = heading ?? null;
    state.driverSpeed = speed ?? null;

    // Instant push to ride subscribers (passenger sees driver move in real-time)
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

    // NO DB WRITE for location updates during ride
    // Driver's global location is handled by DriverStateStore
    return true;
  }

  /**
   * Verify OTP from in-memory state (no DB read needed).
   */
  verifyOtp(rideId: string, providedOtp: string): { valid: boolean; error?: string } {
    const state = this.rides.get(rideId);
    
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

  // ─── Query Methods (In-Memory, No DB) ────────────────────────────────────

  /** Get ride state from memory */
  getRide(rideId: string): RideState | null {
    return this.rides.get(rideId) || null;
  }

  /** Get active ride for a passenger */
  getPassengerActiveRide(passengerId: string): RideState | null {
    const rideId = this.passengerRides.get(passengerId);
    if (!rideId) return null;
    
    const state = this.rides.get(rideId);
    if (!state) return null;
    
    // Only return if ride is actually active
    if (['RIDE_COMPLETED', 'CANCELLED'].includes(state.status)) return null;
    return state;
  }

  /** Get active ride for a driver */
  getDriverActiveRide(driverId: string): RideState | null {
    const rideId = this.driverRides.get(driverId);
    if (!rideId) return null;
    return this.rides.get(rideId) || null;
  }

  /** Get all pending rides (for ride request broadcast) */
  getPendingRides(): RideState[] {
    const result: RideState[] = [];
    for (const rideId of this.pendingRides) {
      const state = this.rides.get(rideId);
      if (state && state.status === 'PENDING') {
        result.push(state);
      }
    }
    return result;
  }

  /** Get all active rides */
  getActiveRides(): RideState[] {
    const active: RideState[] = [];
    for (const state of this.rides.values()) {
      if (!['RIDE_COMPLETED', 'CANCELLED'].includes(state.status)) {
        active.push(state);
      }
    }
    return active;
  }

  /** Check if a ride exists in memory */
  hasRide(rideId: string): boolean {
    return this.rides.has(rideId);
  }

  // ─── Hydration (Load from DB on startup) ─────────────────────────────────

  /**
   * Hydrate in-memory state from database on service startup.
   * Only loads active rides (not completed/cancelled).
   */
  hydrateFromDb(rides: Array<{
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
  }>): void {
    const startTime = Date.now();
    
    for (const ride of rides) {
      const { latLngToH3 } = require('@raahi/shared');
      
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

      this.rides.set(ride.id, state);
      this.passengerRides.set(ride.passengerId, ride.id);
      
      if (ride.driverId) {
        this.driverRides.set(ride.driverId, ride.id);
      }
      if (ride.status === 'PENDING') {
        this.pendingRides.add(ride.id);
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[FIREBALL] Hydrated ${rides.length} active rides from DB in ${elapsed}ms`);
  }

  // ─── Async DB Persistence ────────────────────────────────────────────────

  /** Register callback for async DB writes */
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
            
            // Mark as synced
            const state = this.rides.get(write.rideId);
            if (state) {
              state._dirty = false;
              state._lastSyncedAt = Date.now();
            }
          }
        } catch (error) {
          this.metrics.totalDbWriteFailures++;
          write.retries++;
          
          if (write.retries < this.MAX_WRITE_RETRIES) {
            this.writeQueue.push(write); // Re-queue
            logger.warn(`[FIREBALL] DB write retry ${write.retries}/${this.MAX_WRITE_RETRIES} for ride ${write.rideId}`, { error });
          } else {
            logger.error(`[FIREBALL] DB write FAILED after ${this.MAX_WRITE_RETRIES} retries for ride ${write.rideId}`, { error });
          }
        }
      }
    }, this.FLUSH_INTERVAL_MS);
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────

  private startCleanupLoop(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const toDelete: string[] = [];

      for (const [rideId, state] of this.rides) {
        const isTerminal = state.status === 'RIDE_COMPLETED' || state.status === 'CANCELLED';
        const terminalTime = state.completedAt || state.cancelledAt || 0;
        
        if (isTerminal && (now - terminalTime) > this.COMPLETED_TTL_MS && !state._dirty) {
          toDelete.push(rideId);
        }
      }

      for (const rideId of toDelete) {
        const state = this.rides.get(rideId);
        if (state) {
          this.passengerRides.delete(state.passengerId);
          if (state.driverId) this.driverRides.delete(state.driverId);
          this.pendingRides.delete(rideId);
          this.rides.delete(rideId);
        }
      }

      if (toDelete.length > 0) {
        logger.debug(`[FIREBALL] Cleaned up ${toDelete.length} terminated rides from memory`);
      }
    }, this.CLEANUP_INTERVAL_MS);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Convert state to public-facing format (no internal fields) */
  toPublicState(state: RideState): Record<string, any> {
    const { _dirty, _lastSyncedAt, _version, rideOtp, ...publicFields } = state;
    return publicFields;
  }

  /** Convert state to public format WITH OTP (for passenger) */
  toPublicStateWithOtp(state: RideState): Record<string, any> {
    const { _dirty, _lastSyncedAt, _version, ...publicFields } = state;
    return publicFields;
  }

  /** Convert state to DB-compatible data */
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

  getMetrics() {
    return {
      ...this.metrics,
      ridesInMemory: this.rides.size,
      pendingRides: this.pendingRides.size,
      activePassengers: this.passengerRides.size,
      activeDrivers: this.driverRides.size,
      writeQueueSize: this.writeQueue.length,
      dirtyRides: Array.from(this.rides.values()).filter(r => r._dirty).length,
    };
  }

  /** Shutdown gracefully — flush remaining writes */
  async shutdown(): Promise<void> {
    if (this.flushInterval) clearInterval(this.flushInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    // Flush remaining writes
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

// Singleton
export const rideStateStore = new RideStateStoreImpl();
