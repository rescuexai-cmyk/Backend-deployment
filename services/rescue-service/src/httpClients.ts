import axios, { AxiosError } from 'axios';
import { createLogger } from '@raahi/shared';

const logger = createLogger('rescue-service-http');

const PRICING_SERVICE_URL = process.env.PRICING_SERVICE_URL || 'http://localhost:5005';
const RIDE_SERVICE_URL = process.env.RIDE_SERVICE_URL || 'http://localhost:5004';
const REALTIME_SERVICE_URL = process.env.REALTIME_SERVICE_URL || 'http://localhost:5007';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5006';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'raahi-internal-service-key';

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
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`${operationName} failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})`, {
          error: (error as Error).message,
          statusCode,
        });
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
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

// ─── Pricing Service ──────────────────────────────────────────────────────────

export async function calculateFare(body: {
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  vehicleType?: string;
}) {
  return withRetry(async () => {
    const { data } = await axios.post(`${PRICING_SERVICE_URL}/api/pricing/calculate`, body, {
      timeout: 5000,
      headers: { 'x-internal-api-key': INTERNAL_API_KEY },
    });
    return data.data;
  }, 'calculateFare', MAX_RETRIES, true);
}

// ─── Realtime Service (RAMEN) ─────────────────────────────────────────────────

/**
 * Find nearby bike drivers from RAMEN in-memory H3 index.
 * Rescue drivers are always on bikes, so vehicleType is always 'bike'.
 */
export async function getNearbyBikeDrivers(lat: number, lng: number, radius: number = 10) {
  try {
    const { data } = await axios.get(`${REALTIME_SERVICE_URL}/internal/nearby-drivers`, {
      params: { lat, lng, radius, vehicleType: 'bike' },
      headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      timeout: 3000,
    });
    
    if (data.success && data.data.source === 'in-memory-ramen') {
      logger.info(`[RAMEN] Found ${data.data.count} nearby bike drivers from in-memory store`);
      return data.data.drivers as Array<{ id: string; [key: string]: any }>;
    }
    
    return null;
  } catch (error) {
    logger.debug('RAMEN nearby-drivers unavailable, falling back to pricing service', { error: (error as Error).message });
    return null;
  }
}

/**
 * Fallback: get nearby drivers from pricing service DB query
 */
export async function getNearbyDriversFromDb(lat: number, lng: number, radius: number = 10) {
  return withRetry(async () => {
    const { data } = await axios.get(`${PRICING_SERVICE_URL}/api/pricing/nearby-drivers`, {
      params: { lat, lng, radius, vehicleType: 'bike' },
      timeout: 5000,
      headers: { 'x-internal-api-key': INTERNAL_API_KEY },
    });
    return data.data.drivers as Array<{ id: string }>;
  }, 'getNearbyDriversFromDb', MAX_RETRIES, true);
}

export interface BroadcastResult {
  success: boolean;
  targetedDrivers: number;
  availableDrivers: number;
  connectedDrivers: number;
  errors: string[];
}

/**
 * Broadcast rescue request to nearby bike drivers via realtime service
 */
export async function broadcastRescueRequest(
  rescueId: string, 
  rescueData: any, 
  driverIds: string[]
): Promise<BroadcastResult | null> {
  return withRetry(async () => {
    const response = await axios.post(
      `${REALTIME_SERVICE_URL}/internal/broadcast-ride-request`,
      { 
        rideId: rescueId, // Reuse existing broadcast channel
        rideData: {
          ...rescueData,
          rideType: 'RESCUE',
          priority: 'HIGH',
          isRescueRequest: true,
        }, 
        driverIds,
      },
      { timeout: 5000 }
    );
    
    return response.data.broadcast as BroadcastResult;
  }, `broadcastRescueRequest(${rescueId})`, MAX_RETRIES, false);
}

/**
 * Broadcast rescue status update to user and drivers via realtime service
 */
export async function broadcastRescueStatusUpdate(
  rescueId: string, 
  status: string, 
  data?: any
) {
  return withRetry(async () => {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/ride-status-update`,
      { rideId: rescueId, status, data: { ...data, isRescueUpdate: true } },
      { timeout: 3000 }
    );
  }, `broadcastRescueStatusUpdate(${rescueId})`, MAX_RETRIES, false);
}

/**
 * Broadcast driver assignment for rescue
 */
export async function broadcastDriverAssigned(rescueId: string, driver: any) {
  return withRetry(async () => {
    await axios.post(
      `${REALTIME_SERVICE_URL}/internal/driver-assigned`,
      { rideId: rescueId, driver },
      { timeout: 3000 }
    );
  }, `broadcastDriverAssigned(${rescueId})`, MAX_RETRIES, false);
}

// ─── Notification Service ─────────────────────────────────────────────────────

/**
 * Send push notification to a user
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  notificationData?: Record<string, any>
): Promise<void> {
  try {
    const response = await fetch(`${NOTIFICATION_SERVICE_URL}/api/notifications/internal/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY,
      },
      body: JSON.stringify({
        userId,
        title,
        body,
        data: notificationData || {},
        saveToDb: true,
      }),
    });
    
    if (response.ok) {
      logger.info(`[PUSH] Sent notification to user ${userId}: ${title}`);
    } else {
      logger.warn(`[PUSH] Notification service returned ${response.status} for user ${userId}`);
    }
  } catch (error) {
    logger.warn(`[PUSH] Failed to send notification to user ${userId}`, { error: (error as Error).message });
  }
}

// ─── Ride Service (Internal) ──────────────────────────────────────────────────

/**
 * Create a ride via the ride-service internal API.
 * This creates the actual Ride record for tracking and earnings.
 */
export async function createRideInternal(rideData: {
  passengerId: string;
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  pickupAddress: string;
  dropAddress: string;
  paymentMethod: string;
  vehicleType: string;
  rideType: string;
  driverId: string;
}): Promise<any> {
  return withRetry(async () => {
    const { data } = await axios.post(
      `${RIDE_SERVICE_URL}/api/rides/internal/create-assigned`,
      rideData,
      {
        timeout: 10000,
        headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      }
    );
    return data.data;
  }, 'createRideInternal', MAX_RETRIES, true);
}

/**
 * Update ride status via ride-service
 */
export async function updateRideStatus(
  rideId: string,
  status: string,
  userId: string,
  additionalData?: Record<string, any>
): Promise<any> {
  return withRetry(async () => {
    const { data } = await axios.put(
      `${RIDE_SERVICE_URL}/api/rides/${rideId}/status`,
      { status, userId, ...additionalData },
      {
        timeout: 5000,
        headers: { 
          'x-internal-api-key': INTERNAL_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
    return data.data;
  }, `updateRideStatus(${rideId})`, MAX_RETRIES, true);
}

/**
 * Get ride details from ride-service
 */
export async function getRideDetails(rideId: string): Promise<any> {
  return withRetry(async () => {
    const { data } = await axios.get(
      `${RIDE_SERVICE_URL}/api/rides/internal/${rideId}`,
      {
        timeout: 5000,
        headers: { 'x-internal-api-key': INTERNAL_API_KEY },
      }
    );
    return data.data;
  }, `getRideDetails(${rideId})`, MAX_RETRIES, false);
}
