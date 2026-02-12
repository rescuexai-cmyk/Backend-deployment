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
  // Location updates are high-frequency and non-critical - don't retry
  try {
    await axios.post(
      `${REALTIME_SERVICE_URL}/api/realtime/update-driver-location`,
      { driverId, lat, lng, heading, speed },
      { timeout: 2000 } // Shorter timeout for location updates
    );
  } catch (error) {
    // Silently fail location updates - they're sent frequently
    logger.debug('Location update failed', { driverId, error: (error as Error).message });
  }
}
