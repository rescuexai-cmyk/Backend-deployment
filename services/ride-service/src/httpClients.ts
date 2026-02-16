import axios, { AxiosError } from 'axios';
import { createLogger } from '@raahi/shared';

const logger = createLogger('ride-service-http');

const PRICING_SERVICE_URL = process.env.PRICING_SERVICE_URL || 'http://localhost:5005';
const REALTIME_SERVICE_URL = process.env.REALTIME_SERVICE_URL || 'http://localhost:5007';

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

/**
 * Retry wrapper for HTTP calls with exponential backoff
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries: number = MAX_RETRIES,
  isCritical: boolean = true
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      const isAxiosError = axios.isAxiosError(error);
      const statusCode = isAxiosError ? (error as AxiosError).response?.status : undefined;
      
      // Don't retry on 4xx client errors (except 429 rate limit)
      if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 429) {
        logger.error(`${operationName} failed with client error`, { 
          statusCode, 
          message: (error as Error).message 
        });
        throw error;
      }
      
      if (attempt < maxRetries) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff
        logger.warn(`${operationName} failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`, {
          error: (error as Error).message,
          statusCode,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  // All retries exhausted
  if (isCritical) {
    logger.error(`${operationName} failed after ${maxRetries} attempts`, { 
      error: lastError?.message 
    });
    throw lastError;
  } else {
    logger.warn(`${operationName} failed after ${maxRetries} attempts (non-critical)`, { 
      error: lastError?.message 
    });
    throw lastError;
  }
}

export async function calculateFare(body: {
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  vehicleType?: string;
  scheduledTime?: string;
}) {
  return withRetry(async () => {
    const { data } = await axios.post(`${PRICING_SERVICE_URL}/api/pricing/calculate`, body, {
      timeout: 5000,
    });
    return data.data;
  }, 'calculateFare', MAX_RETRIES, true);
}

export async function getNearbyDrivers(lat: number, lng: number, radius: number = 5) {
  return withRetry(async () => {
    const { data } = await axios.get(`${PRICING_SERVICE_URL}/api/pricing/nearby-drivers`, {
      params: { lat, lng, radius },
      timeout: 5000,
    });
    return data.data.drivers as Array<{ id: string }>;
  }, 'getNearbyDrivers', MAX_RETRIES, true);
}

export interface BroadcastResult {
  success: boolean;
  targetedDrivers: number;
  availableDrivers: number;
  connectedDrivers: number;
  errors: string[];
}

export async function broadcastRideRequest(rideId: string, rideData: any, driverIds: string[]): Promise<BroadcastResult | null> {
  return withRetry(async () => {
    const response = await axios.post(
      `${REALTIME_SERVICE_URL}/internal/broadcast-ride-request`,
      { rideId, rideData, driverIds },
      { timeout: 5000 } // Increased timeout for detailed response
    );
    
    // Return the broadcast result for logging
    return response.data.broadcast as BroadcastResult;
  }, `broadcastRideRequest(${rideId})`, MAX_RETRIES, false); // Non-critical - ride is already saved
}

export async function broadcastRideStatusUpdate(rideId: string, status: string, data?: any) {
  return withRetry(async () => {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/ride-status-update`,
      { rideId, status, data },
      { timeout: 3000 }
    );
  }, `broadcastRideStatusUpdate(${rideId})`, MAX_RETRIES, false);
}

export async function broadcastDriverAssigned(rideId: string, driver: any) {
  return withRetry(async () => {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/driver-assigned`,
      { rideId, driver },
      { timeout: 3000 }
    );
  }, `broadcastDriverAssigned(${rideId})`, MAX_RETRIES, false);
}

export async function broadcastRideCancelled(rideId: string, cancelledBy: string, reason?: string) {
  return withRetry(async () => {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/ride-cancelled`,
      { rideId, cancelledBy, reason },
      { timeout: 3000 }
    );
  }, `broadcastRideCancelled(${rideId})`, MAX_RETRIES, false);
}

export async function broadcastRideChatMessage(
  rideId: string,
  message: { id: string; senderId: string; message: string; timestamp: Date }
) {
  try {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/broadcast-ride-chat`,
      { rideId, message: { ...message, timestamp: message.timestamp.toISOString() } },
      { timeout: 3000 }
    );
  } catch (e) {
    logger.debug('Broadcast ride chat failed', { rideId, error: (e as Error).message });
  }
}

export async function updateDriverLocationRealtime(driverId: string, lat: number, lng: number, heading?: number, speed?: number) {
  // Location updates go to RAMEN (in-memory) first, then async to DB
  try {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/driver-location`,
      { driverId, lat, lng, heading, speed },
      { 
        timeout: 2000,
        headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      }
    );
  } catch (error) {
    // Fallback to legacy endpoint if RAMEN is down
    try {
      await axios.post(
        `${REALTIME_SERVICE_URL}/api/realtime/update-driver-location`,
        { driverId, lat, lng, heading, speed },
        { timeout: 2000 }
      );
    } catch {
      logger.debug('Location update failed', { driverId, error: (error as Error).message });
    }
  }
}

// ─── RAMEN/Fireball In-Memory State APIs ──────────────────────────────────────

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';

/**
 * Find nearby drivers from RAMEN in-memory H3 index (0.01ms vs 20-100ms DB query).
 * Falls back to pricing service DB query if RAMEN is unavailable.
 */
export async function getNearbyDriversFromMemory(lat: number, lng: number, radius: number = 10, vehicleType?: string) {
  try {
    const { data } = await axios.get(`${REALTIME_SERVICE_URL}/internal/nearby-drivers`, {
      params: { lat, lng, radius, vehicleType },
      headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      timeout: 3000,
    });
    
    if (data.success && data.data.source === 'in-memory-ramen') {
      logger.info(`[RAMEN] Found ${data.data.count} nearby drivers from in-memory store`);
      return data.data.drivers as Array<{ id: string; [key: string]: any }>;
    }
    
    // Fall back to DB query
    return null;
  } catch (error) {
    logger.debug('RAMEN nearby-drivers unavailable, falling back to DB', { error: (error as Error).message });
    return null;
  }
}

/**
 * Register ride in Fireball in-memory state store.
 * Called after creating the ride in the database.
 */
export async function registerRideInFireball(ride: any) {
  try {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/register-ride`,
      { ride },
      {
        timeout: 3000,
        headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      }
    );
    logger.info(`[FIREBALL] Ride ${ride.id} registered in memory`);
  } catch (error) {
    logger.debug('Fireball registration failed (non-critical)', { error: (error as Error).message });
  }
}

/**
 * Transition ride status via Fireball (instant push, async DB write).
 * Falls back to direct DB write if Fireball is unavailable.
 */
export async function transitionRideViaFireball(
  rideId: string,
  newStatus: string,
  triggeredBy: string,
  additionalData?: Record<string, any>,
): Promise<boolean> {
  try {
    const { data } = await axios.post(
      `${REALTIME_SERVICE_URL}/internal/ride-transition`,
      { rideId, newStatus, triggeredBy, additionalData },
      {
        timeout: 3000,
        headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      }
    );
    return data.success;
  } catch (error) {
    logger.debug('Fireball transition failed, falling back to direct update', { error: (error as Error).message });
    return false;
  }
}

/**
 * Verify OTP via Fireball (in-memory, no DB read).
 * Falls back to DB read if Fireball is unavailable.
 */
export async function verifyOtpViaFireball(rideId: string, otp: string): Promise<{ valid: boolean; error?: string } | null> {
  try {
    const { data } = await axios.post(
      `${REALTIME_SERVICE_URL}/internal/verify-otp`,
      { rideId, otp },
      {
        timeout: 2000,
        headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      }
    );
    return { valid: data.success, error: data.error };
  } catch (error) {
    logger.debug('Fireball OTP verification unavailable, falling back to DB', { error: (error as Error).message });
    return null; // null = use DB fallback
  }
}

/**
 * Update ride location via Fireball (in-memory, no DB write, instant push).
 */
export async function updateRideLocationViaFireball(rideId: string, lat: number, lng: number, heading?: number, speed?: number) {
  try {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/ride-location`,
      { rideId, lat, lng, heading, speed },
      {
        timeout: 2000,
        headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      }
    );
  } catch (error) {
    // Non-critical - location updates are high frequency
    logger.debug('Fireball ride-location failed', { error: (error as Error).message });
  }
}
