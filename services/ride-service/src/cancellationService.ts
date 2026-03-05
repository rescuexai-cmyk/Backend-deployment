/**
 * Cancellation Fee Service
 * Implements cancellation policy per vehicle type
 * 
 * Rules:
 * - Cancelled before driver assigned: ₹0
 * - Cancelled within 2 min of assignment: ₹0
 * - Cancelled after driver arrived and waited 3+ minutes: per-minute fee
 */

import { createLogger } from '@raahi/shared';

const logger = createLogger('cancellation-service');

// Default cancellation policies per vehicle type
const CANCELLATION_POLICIES: Record<string, {
  freeWindowMinutes: number;
  freeWaitingMinutes: number;
  waitingFeePerMin: number;
}> = {
  cab_mini: { freeWindowMinutes: 2, freeWaitingMinutes: 3, waitingFeePerMin: 2.0 },
  auto: { freeWindowMinutes: 2, freeWaitingMinutes: 3, waitingFeePerMin: 1.5 },
  cab_xl: { freeWindowMinutes: 2, freeWaitingMinutes: 3, waitingFeePerMin: 2.5 },
  bike_rescue: { freeWindowMinutes: 2, freeWaitingMinutes: 3, waitingFeePerMin: 1.0 },
  cab_premium: { freeWindowMinutes: 2, freeWaitingMinutes: 3, waitingFeePerMin: 3.5 },
  personal_driver: { freeWindowMinutes: 2, freeWaitingMinutes: 3, waitingFeePerMin: 3.5 },
};

export interface CancellationFeeResult {
  fee: number;
  reason: string;
  breakdown?: {
    waitingMinutes: number;
    chargeableMinutes: number;
    ratePerMin: number;
  };
}

export interface CancellationContext {
  vehicleType: string;
  driverAssignedAt?: Date | null;
  driverArrivedAt?: Date | null;
  cancelledAt: Date;
  driverId?: string | null;
}

/**
 * Calculate cancellation fee based on ride context
 */
export function calculateCancellationFee(context: CancellationContext): CancellationFeeResult {
  const { vehicleType, driverAssignedAt, driverArrivedAt, cancelledAt, driverId } = context;
  const policy = CANCELLATION_POLICIES[vehicleType.toLowerCase()] || CANCELLATION_POLICIES.cab_mini;

  // Rule 1: No driver assigned yet
  if (!driverId || !driverAssignedAt) {
    logger.info(`[CANCEL] No driver assigned, fee: ₹0`);
    return { fee: 0, reason: 'No driver assigned' };
  }

  const assignedTime = new Date(driverAssignedAt).getTime();
  const cancelTime = new Date(cancelledAt).getTime();
  const minutesSinceAssignment = (cancelTime - assignedTime) / (1000 * 60);

  // Rule 2: Cancelled within free window after assignment
  if (minutesSinceAssignment <= policy.freeWindowMinutes) {
    logger.info(`[CANCEL] Within ${policy.freeWindowMinutes} min free window, fee: ₹0`);
    return { fee: 0, reason: `Cancelled within ${policy.freeWindowMinutes} minutes of assignment` };
  }

  // Rule 3: Driver hasn't arrived yet - flat fee based on time wasted
  if (!driverArrivedAt) {
    // Charge a nominal fee for driver's time (half rate)
    const chargeableMinutes = Math.ceil(minutesSinceAssignment - policy.freeWindowMinutes);
    const fee = Math.round(chargeableMinutes * (policy.waitingFeePerMin / 2));
    logger.info(`[CANCEL] Driver en-route, ${chargeableMinutes} min after free window, fee: ₹${fee}`);
    return {
      fee,
      reason: `Driver was en-route for ${Math.ceil(minutesSinceAssignment)} minutes`,
      breakdown: {
        waitingMinutes: Math.ceil(minutesSinceAssignment),
        chargeableMinutes,
        ratePerMin: policy.waitingFeePerMin / 2,
      },
    };
  }

  // Rule 4: Driver arrived - calculate waiting time
  const arrivedTime = new Date(driverArrivedAt).getTime();
  const waitingMinutes = (cancelTime - arrivedTime) / (1000 * 60);

  // Free waiting period
  if (waitingMinutes <= policy.freeWaitingMinutes) {
    logger.info(`[CANCEL] Within ${policy.freeWaitingMinutes} min free waiting, fee: ₹0`);
    return { fee: 0, reason: `Cancelled within ${policy.freeWaitingMinutes} minutes of driver arrival` };
  }

  // Chargeable waiting time
  const chargeableMinutes = Math.ceil(waitingMinutes - policy.freeWaitingMinutes);
  const fee = Math.round(chargeableMinutes * policy.waitingFeePerMin);

  logger.info(`[CANCEL] Driver waited ${Math.ceil(waitingMinutes)} min (${chargeableMinutes} chargeable), fee: ₹${fee}`);

  return {
    fee,
    reason: `Driver waited ${Math.ceil(waitingMinutes)} minutes after arrival`,
    breakdown: {
      waitingMinutes: Math.ceil(waitingMinutes),
      chargeableMinutes,
      ratePerMin: policy.waitingFeePerMin,
    },
  };
}

/**
 * Get cancellation policy for a vehicle type
 */
export function getCancellationPolicy(vehicleType: string) {
  return CANCELLATION_POLICIES[vehicleType.toLowerCase()] || CANCELLATION_POLICIES.cab_mini;
}
