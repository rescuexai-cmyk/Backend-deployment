/**
 * DriverStateStore — Redis-backed Driver State & Geospatial Index
 * 
 * Migrated from in-memory Map to Redis for horizontal scaling.
 * All instances of realtime-service now share driver state.
 * 
 * Redis Data Structures:
 *   drivers:{driverId}     → Hash with driver state
 *   user:driver:{userId}   → String mapping userId to driverId
 *   h3:{h3Index}           → Set of driverIds in that cell
 *   online:drivers         → Set of online driver IDs
 * 
 * Falls back to in-memory if Redis is unavailable (single-instance mode).
 */

import { createLogger, getRedisClient, isRedisAvailable } from '@raahi/shared';
import { latLngToH3, getKRing, getH3Config } from '@raahi/shared';
import { eventBus, CHANNELS } from './eventBus';

const logger = createLogger('driver-state-store');

// ─── Redis Keys ───────────────────────────────────────────────────────────────

const KEYS = {
  driver: (id: string) => `driver:${id}`,
  userToDriver: (userId: string) => `user:driver:${userId}`,
  h3Cell: (h3Index: string) => `h3:${h3Index}`,
  onlineDrivers: 'online:drivers',
  metrics: 'metrics:drivers',
};

// ─── Driver State Types ───────────────────────────────────────────────────────

export interface DriverState {
  id: string;
  userId: string;
  
  isOnline: boolean;
  isActive: boolean;
  isVerified: boolean;
  
  lat: number | null;
  lng: number | null;
  h3Index: string | null;
  heading: number | null;
  speed: number | null;
  lastLocationAt: number | null;
  
  firstName: string;
  lastName: string | null;
  phone: string | null;
  profileImage: string | null;
  vehicleNumber: string | null;
  vehicleModel: string | null;
  vehicleType: string | null;
  rating: number;
  ratingCount: number;
  totalRides: number;
  
  connectedTransports: Set<string>;
  lastActiveAt: number;
  
  _locationDirty: boolean;
  _statusDirty: boolean;
  _lastDbSyncAt: number;
}

// Serializable version for Redis (Sets become arrays)
interface DriverStateRedis extends Omit<DriverState, 'connectedTransports'> {
  connectedTransports: string[];
}

// ─── DB Write Queue ───────────────────────────────────────────────────────────

export interface DriverDbWrite {
  driverId: string;
  operation: 'location_update' | 'status_change' | 'full_sync';
  data: Record<string, any>;
  timestamp: number;
  retries: number;
}

// ─── Serialization Helpers ────────────────────────────────────────────────────

function serializeState(state: DriverState): string {
  const serializable: DriverStateRedis = {
    ...state,
    connectedTransports: Array.from(state.connectedTransports),
  };
  return JSON.stringify(serializable);
}

function deserializeState(json: string): DriverState {
  const parsed: DriverStateRedis = JSON.parse(json);
  return {
    ...parsed,
    connectedTransports: new Set(parsed.connectedTransports || []),
  };
}

// ─── DriverStateStore Implementation ──────────────────────────────────────────

class DriverStateStoreImpl {
  // Fallback in-memory storage (used when Redis unavailable)
  private localDrivers = new Map<string, DriverState>();
  private localUserToDriver = new Map<string, string>();
  private localH3CellIndex = new Map<string, Set<string>>();
  private localOnlineDrivers = new Set<string>();
  
  private writeQueue: DriverDbWrite[] = [];
  private dbSyncCallback: ((write: DriverDbWrite) => Promise<void>) | null = null;
  
  private locationFlushInterval: NodeJS.Timeout | null = null;
  private statusFlushInterval: NodeJS.Timeout | null = null;
  
  private readonly LOCATION_FLUSH_MS = 2000;
  private readonly STATUS_FLUSH_MS = 500;
  private readonly STALE_DRIVER_MS = 5 * 60 * 1000;
  private readonly MAX_RETRIES = 3;
  private readonly DRIVER_TTL_SECONDS = 24 * 60 * 60; // 24 hours

  private metrics = {
    locationUpdates: 0,
    nearbyDriverQueries: 0,
    avgNearbyLatencyUs: 0,
    h3CellsTracked: 0,
    totalDbWrites: 0,
    dbWriteFailures: 0,
  };

  private redisEnabled = false;

  constructor() {
    this.initRedis();
    this.startFlushLoops();
    logger.info('[RAMEN] DriverStateStore initialized');
  }

  private async initRedis(): Promise<void> {
    const client = getRedisClient();
    if (client) {
      this.redisEnabled = true;
      logger.info('[RAMEN] Redis mode enabled - horizontal scaling supported');
    } else {
      this.redisEnabled = false;
      logger.warn('[RAMEN] Redis unavailable - falling back to in-memory (single instance only)');
    }
  }

  private useRedis(): boolean {
    return this.redisEnabled && isRedisAvailable();
  }

  // ─── Driver Registration ─────────────────────────────────────────────────

  async registerDriver(driver: {
    id: string;
    userId: string;
    isOnline: boolean;
    isActive: boolean;
    isVerified: boolean;
    currentLatitude: number | null;
    currentLongitude: number | null;
    h3Index: string | null;
    firstName: string;
    lastName: string | null;
    phone: string | null;
    profileImage: string | null;
    vehicleNumber: string | null;
    vehicleModel: string | null;
    vehicleType: string | null;
    rating: number;
    ratingCount: number;
    totalRides: number;
  }): Promise<DriverState> {
    const existing = await this.getDriver(driver.id);
    
    const state: DriverState = {
      id: driver.id,
      userId: driver.userId,
      isOnline: driver.isOnline,
      isActive: driver.isActive,
      isVerified: driver.isVerified,
      lat: driver.currentLatitude,
      lng: driver.currentLongitude,
      h3Index: driver.h3Index,
      heading: null,
      speed: null,
      lastLocationAt: driver.currentLatitude ? Date.now() : null,
      firstName: driver.firstName,
      lastName: driver.lastName,
      phone: driver.phone,
      profileImage: driver.profileImage,
      vehicleNumber: driver.vehicleNumber,
      vehicleModel: driver.vehicleModel,
      vehicleType: driver.vehicleType,
      rating: driver.rating,
      ratingCount: driver.ratingCount,
      totalRides: driver.totalRides,
      connectedTransports: existing?.connectedTransports || new Set(),
      lastActiveAt: Date.now(),
      _locationDirty: false,
      _statusDirty: false,
      _lastDbSyncAt: Date.now(),
    };

    if (this.useRedis()) {
      const client = getRedisClient();
      const pipeline = client.pipeline();
      
      pipeline.setex(KEYS.driver(driver.id), this.DRIVER_TTL_SECONDS, serializeState(state));
      pipeline.set(KEYS.userToDriver(driver.userId), driver.id);
      
      if (driver.isOnline) {
        pipeline.sadd(KEYS.onlineDrivers, driver.id);
      }
      
      if (driver.h3Index) {
        pipeline.sadd(KEYS.h3Cell(driver.h3Index), driver.id);
      }
      
      await pipeline.exec();
    } else {
      this.localDrivers.set(driver.id, state);
      this.localUserToDriver.set(driver.userId, driver.id);
      
      if (driver.isOnline) {
        this.localOnlineDrivers.add(driver.id);
      }
      
      if (driver.h3Index) {
        if (!this.localH3CellIndex.has(driver.h3Index)) {
          this.localH3CellIndex.set(driver.h3Index, new Set());
        }
        this.localH3CellIndex.get(driver.h3Index)!.add(driver.id);
      }
    }

    logger.debug(`[RAMEN] Driver registered: ${driver.id} (online=${driver.isOnline}, h3=${driver.h3Index})`);
    return state;
  }

  // ─── Location Updates (IN-MEMORY + REDIS, NO DB) ─────────────────────────

  async updateLocation(
    driverId: string,
    lat: number,
    lng: number,
    heading?: number,
    speed?: number,
  ): Promise<{ h3Changed: boolean; newH3: string } | null> {
    const state = await this.getDriver(driverId);
    if (!state) return null;

    const newH3 = latLngToH3(lat, lng);
    const h3Changed = state.h3Index !== newH3;
    const oldH3 = state.h3Index;

    state.lat = lat;
    state.lng = lng;
    state.heading = heading ?? null;
    state.speed = speed ?? null;
    state.lastLocationAt = Date.now();
    state.lastActiveAt = Date.now();
    state._locationDirty = true;

    if (this.useRedis()) {
      const client = getRedisClient();
      const pipeline = client.pipeline();
      
      pipeline.setex(KEYS.driver(driverId), this.DRIVER_TTL_SECONDS, serializeState(state));
      
      if (h3Changed) {
        if (oldH3) {
          pipeline.srem(KEYS.h3Cell(oldH3), driverId);
        }
        pipeline.sadd(KEYS.h3Cell(newH3), driverId);
        state.h3Index = newH3;
      }
      
      await pipeline.exec();
    } else {
      this.localDrivers.set(driverId, state);
      
      if (h3Changed) {
        if (oldH3) {
          const oldCell = this.localH3CellIndex.get(oldH3);
          if (oldCell) {
            oldCell.delete(driverId);
            if (oldCell.size === 0) {
              this.localH3CellIndex.delete(oldH3);
            }
          }
        }
        state.h3Index = newH3;
        if (!this.localH3CellIndex.has(newH3)) {
          this.localH3CellIndex.set(newH3, new Set());
        }
        this.localH3CellIndex.get(newH3)!.add(driverId);
        
        logger.debug(`[RAMEN] Driver ${driverId} H3 cell changed: ${oldH3} → ${newH3}`);
      }
    }

    this.metrics.locationUpdates++;

    eventBus.publish(CHANNELS.driverLocations, {
      type: 'driver-location',
      driverId,
      lat,
      lng,
      h3Index: newH3,
      heading,
      speed,
      timestamp: new Date().toISOString(),
    });

    return { h3Changed, newH3 };
  }

  // ─── Status Changes ──────────────────────────────────────────────────────

  async setOnlineStatus(driverId: string, isOnline: boolean): Promise<boolean> {
    const state = await this.getDriver(driverId);
    if (!state) return false;

    const wasOnline = state.isOnline;
    state.isOnline = isOnline;
    state.lastActiveAt = Date.now();
    state._statusDirty = true;

    if (this.useRedis()) {
      const client = getRedisClient();
      const pipeline = client.pipeline();
      
      pipeline.setex(KEYS.driver(driverId), this.DRIVER_TTL_SECONDS, serializeState(state));
      
      if (isOnline && !wasOnline) {
        pipeline.sadd(KEYS.onlineDrivers, driverId);
        logger.info(`[RAMEN] Driver ${driverId} went ONLINE`);
      } else if (!isOnline && wasOnline) {
        pipeline.srem(KEYS.onlineDrivers, driverId);
        logger.info(`[RAMEN] Driver ${driverId} went OFFLINE`);
      }
      
      await pipeline.exec();
    } else {
      this.localDrivers.set(driverId, state);
      
      if (isOnline && !wasOnline) {
        this.localOnlineDrivers.add(driverId);
        logger.info(`[RAMEN] Driver ${driverId} went ONLINE`);
      } else if (!isOnline && wasOnline) {
        this.localOnlineDrivers.delete(driverId);
        logger.info(`[RAMEN] Driver ${driverId} went OFFLINE`);
      }
    }

    this.writeQueue.push({
      driverId,
      operation: 'status_change',
      data: { isOnline, lastActiveAt: new Date() },
      timestamp: Date.now(),
      retries: 0,
    });

    return true;
  }

  async addTransport(driverId: string, transport: string): Promise<void> {
    const state = await this.getDriver(driverId);
    if (state) {
      state.connectedTransports.add(transport);
      state.lastActiveAt = Date.now();
      
      if (this.useRedis()) {
        await getRedisClient().setex(KEYS.driver(driverId), this.DRIVER_TTL_SECONDS, serializeState(state));
      } else {
        this.localDrivers.set(driverId, state);
      }
    }
  }

  async removeTransport(driverId: string, transport: string): Promise<void> {
    const state = await this.getDriver(driverId);
    if (state) {
      state.connectedTransports.delete(transport);
      
      if (this.useRedis()) {
        await getRedisClient().setex(KEYS.driver(driverId), this.DRIVER_TTL_SECONDS, serializeState(state));
      } else {
        this.localDrivers.set(driverId, state);
      }
    }
  }

  // ─── Geospatial Queries (IN-MEMORY or REDIS) ──────────────────────────────

  async findNearbyDrivers(
    lat: number,
    lng: number,
    maxRadiusKm: number = 10,
    vehicleType?: string,
  ): Promise<DriverState[]> {
    const startTime = performance.now();
    const config = getH3Config();
    const centerH3 = latLngToH3(lat, lng);
    
    const candidateIds = new Set<string>();

    for (let k = 1; k <= config.maxKRing; k++) {
      const cells = getKRing(centerH3, k);
      
      if (this.useRedis()) {
        const client = getRedisClient();
        const pipeline = client.pipeline();
        
        for (const cell of cells) {
          pipeline.smembers(KEYS.h3Cell(cell));
        }
        
        const results = await pipeline.exec();
        for (const [err, members] of results || []) {
          if (!err && members) {
            for (const driverId of members as string[]) {
              candidateIds.add(driverId);
            }
          }
        }
      } else {
        for (const cell of cells) {
          const driversInCell = this.localH3CellIndex.get(cell);
          if (driversInCell) {
            for (const driverId of driversInCell) {
              candidateIds.add(driverId);
            }
          }
        }
      }

      if (candidateIds.size > 0) break;
    }

    const heartbeatThreshold = Date.now() - this.STALE_DRIVER_MS;
    const candidates: DriverState[] = [];
    
    if (this.useRedis()) {
      const client = getRedisClient();
      const pipeline = client.pipeline();
      
      for (const id of candidateIds) {
        pipeline.get(KEYS.driver(id));
      }
      
      const results = await pipeline.exec();
      for (const [err, data] of results || []) {
        if (!err && data) {
          const driver = deserializeState(data as string);
          candidates.push(driver);
        }
      }
    } else {
      for (const id of candidateIds) {
        const driver = this.localDrivers.get(id);
        if (driver) candidates.push(driver);
      }
    }
    
    const results = candidates
      .filter((d): d is DriverState => {
        if (!d) return false;
        if (!d.isOnline || !d.isActive) return false;
        if (!d.lat || !d.lng) return false;
        if (d.lastActiveAt < heartbeatThreshold) return false;
        if (vehicleType && d.vehicleType !== vehicleType) return false;
        return true;
      })
      .map(d => ({
        driver: d,
        distance: this.haversineDistance(lat, lng, d.lat!, d.lng!),
      }))
      .filter(({ distance }) => distance <= maxRadiusKm)
      .sort((a, b) => a.distance - b.distance)
      .map(({ driver }) => driver);

    const latencyUs = (performance.now() - startTime) * 1000;
    this.metrics.nearbyDriverQueries++;
    this.metrics.avgNearbyLatencyUs = 
      (this.metrics.avgNearbyLatencyUs * (this.metrics.nearbyDriverQueries - 1) + latencyUs) 
      / this.metrics.nearbyDriverQueries;

    logger.info(`[RAMEN] findNearbyDrivers: (${lat},${lng}) → ${results.length} drivers in ${latencyUs.toFixed(0)}µs`);

    return results;
  }

  async getDriverCountInArea(lat: number, lng: number, kRing: number = 1): Promise<number> {
    const centerH3 = latLngToH3(lat, lng);
    const cells = getKRing(centerH3, kRing);
    let count = 0;
    
    if (this.useRedis()) {
      const client = getRedisClient();
      const pipeline = client.pipeline();
      
      for (const cell of cells) {
        pipeline.smembers(KEYS.h3Cell(cell));
      }
      
      const results = await pipeline.exec();
      const driverIds = new Set<string>();
      
      for (const [err, members] of results || []) {
        if (!err && members) {
          for (const id of members as string[]) {
            driverIds.add(id);
          }
        }
      }
      
      const statePipeline = client.pipeline();
      for (const id of driverIds) {
        statePipeline.get(KEYS.driver(id));
      }
      
      const stateResults = await statePipeline.exec();
      for (const [err, data] of stateResults || []) {
        if (!err && data) {
          const state = deserializeState(data as string);
          if (state?.isOnline && state?.isActive) count++;
        }
      }
    } else {
      for (const cell of cells) {
        const drivers = this.localH3CellIndex.get(cell);
        if (drivers) {
          for (const driverId of drivers) {
            const state = this.localDrivers.get(driverId);
            if (state?.isOnline && state?.isActive) count++;
          }
        }
      }
    }
    
    return count;
  }

  // ─── Lookups (O(1)) ───────────────────────────────────────────────────────

  async getDriver(driverId: string): Promise<DriverState | null> {
    if (this.useRedis()) {
      const data = await getRedisClient().get(KEYS.driver(driverId));
      return data ? deserializeState(data) : null;
    }
    return this.localDrivers.get(driverId) || null;
  }

  async getDriverByUserId(userId: string): Promise<DriverState | null> {
    if (this.useRedis()) {
      const driverId = await getRedisClient().get(KEYS.userToDriver(userId));
      if (!driverId) return null;
      return this.getDriver(driverId);
    }
    const driverId = this.localUserToDriver.get(userId);
    if (!driverId) return null;
    return this.localDrivers.get(driverId) || null;
  }

  async resolveDriverId(inputId: string): Promise<string | null> {
    if (this.useRedis()) {
      const exists = await getRedisClient().exists(KEYS.driver(inputId));
      if (exists) return inputId;
      const driverId = await getRedisClient().get(KEYS.userToDriver(inputId));
      return driverId || null;
    }
    if (this.localDrivers.has(inputId)) return inputId;
    return this.localUserToDriver.get(inputId) || null;
  }

  async isDriverOnline(driverId: string): Promise<boolean> {
    if (this.useRedis()) {
      return (await getRedisClient().sismember(KEYS.onlineDrivers, driverId)) === 1;
    }
    return this.localOnlineDrivers.has(driverId);
  }

  async getOnlineDriverCount(): Promise<number> {
    if (this.useRedis()) {
      return await getRedisClient().scard(KEYS.onlineDrivers);
    }
    return this.localOnlineDrivers.size;
  }

  async getOnlineDriverIds(): Promise<string[]> {
    if (this.useRedis()) {
      return await getRedisClient().smembers(KEYS.onlineDrivers);
    }
    return Array.from(this.localOnlineDrivers);
  }

  // ─── DB Hydration ────────────────────────────────────────────────────────

  async hydrateFromDb(drivers: Array<{
    id: string;
    userId: string;
    isOnline: boolean;
    isActive: boolean;
    isVerified: boolean;
    currentLatitude: number | null;
    currentLongitude: number | null;
    h3Index: string | null;
    lastActiveAt: Date | null;
    vehicleNumber: string | null;
    vehicleModel: string | null;
    vehicleType: string | null;
    rating: number;
    ratingCount: number;
    totalRides: number;
    user: {
      firstName: string;
      lastName: string | null;
      phone: string | null;
      profileImage: string | null;
    };
  }>): Promise<void> {
    const startTime = Date.now();
    
    for (const d of drivers) {
      await this.registerDriver({
        id: d.id,
        userId: d.userId,
        isOnline: d.isOnline,
        isActive: d.isActive,
        isVerified: d.isVerified,
        currentLatitude: d.currentLatitude,
        currentLongitude: d.currentLongitude,
        h3Index: d.h3Index,
        firstName: d.user.firstName,
        lastName: d.user.lastName || '',
        phone: d.user.phone,
        profileImage: d.user.profileImage,
        vehicleNumber: d.vehicleNumber,
        vehicleModel: d.vehicleModel,
        vehicleType: d.vehicleType,
        rating: d.rating,
        ratingCount: d.ratingCount,
        totalRides: d.totalRides,
      });
    }

    const elapsed = Date.now() - startTime;
    const onlineCount = await this.getOnlineDriverCount();
    logger.info(`[RAMEN] Hydrated ${drivers.length} drivers from DB in ${elapsed}ms (${onlineCount} online, redis=${this.useRedis()})`);
  }

  // ─── Async DB Persistence ────────────────────────────────────────────────

  onDbSync(callback: (write: DriverDbWrite) => Promise<void>): void {
    this.dbSyncCallback = callback;
  }

  private startFlushLoops(): void {
    this.locationFlushInterval = setInterval(async () => {
      const locationWrites: DriverDbWrite[] = [];
      
      let drivers: DriverState[] = [];
      
      if (this.useRedis()) {
        const client = getRedisClient();
        const onlineIds = await client.smembers(KEYS.onlineDrivers);
        
        if (onlineIds.length > 0) {
          const pipeline = client.pipeline();
          for (const id of onlineIds) {
            pipeline.get(KEYS.driver(id));
          }
          
          const results = await pipeline.exec();
          for (const [err, data] of results || []) {
            if (!err && data) {
              drivers.push(deserializeState(data as string));
            }
          }
        }
      } else {
        drivers = Array.from(this.localDrivers.values());
      }
      
      for (const state of drivers) {
        if (state._locationDirty && state.lat !== null && state.lng !== null) {
          locationWrites.push({
            driverId: state.id,
            operation: 'location_update',
            data: {
              currentLatitude: state.lat,
              currentLongitude: state.lng,
              h3Index: state.h3Index,
              lastActiveAt: new Date(state.lastActiveAt),
            },
            timestamp: Date.now(),
            retries: 0,
          });
          state._locationDirty = false;
          state._lastDbSyncAt = Date.now();
          
          if (this.useRedis()) {
            await getRedisClient().setex(KEYS.driver(state.id), this.DRIVER_TTL_SECONDS, serializeState(state));
          }
        }
      }

      if (locationWrites.length > 0 && this.dbSyncCallback) {
        for (const write of locationWrites) {
          try {
            await this.dbSyncCallback(write);
            this.metrics.totalDbWrites++;
          } catch (error) {
            this.metrics.dbWriteFailures++;
            logger.debug(`[RAMEN] Location DB write failed for ${write.driverId}`, { error });
          }
        }
      }
    }, this.LOCATION_FLUSH_MS);

    this.statusFlushInterval = setInterval(async () => {
      const batch = this.writeQueue.splice(0, this.writeQueue.length);
      
      for (const write of batch) {
        try {
          if (this.dbSyncCallback) {
            await this.dbSyncCallback(write);
            this.metrics.totalDbWrites++;
          }
        } catch (error) {
          this.metrics.dbWriteFailures++;
          write.retries++;
          if (write.retries < this.MAX_RETRIES) {
            this.writeQueue.push(write);
          }
        }
      }
    }, this.STATUS_FLUSH_MS);
  }

  // ─── Utility ─────────────────────────────────────────────────────────────

  private haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ─── Metrics ─────────────────────────────────────────────────────────────

  async getMetrics() {
    const onlineCount = await this.getOnlineDriverCount();
    
    return {
      ...this.metrics,
      totalDrivers: this.useRedis() ? 'redis' : this.localDrivers.size,
      onlineDrivers: onlineCount,
      redisEnabled: this.useRedis(),
      writeQueueSize: this.writeQueue.length,
    };
  }

  async shutdown(): Promise<void> {
    if (this.locationFlushInterval) clearInterval(this.locationFlushInterval);
    if (this.statusFlushInterval) clearInterval(this.statusFlushInterval);
    logger.info('[RAMEN] DriverStateStore shut down');
  }
}

export const driverStateStore = new DriverStateStoreImpl();
