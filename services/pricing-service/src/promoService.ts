/**
 * Promo Service
 * Handles promo code validation, application, and usage tracking
 */

import { prisma } from '@raahi/shared';
import { createLogger } from '@raahi/shared';

const logger = createLogger('promo-service');

export interface PromoValidationResult {
  valid: boolean;
  error?: string;
  promo?: {
    id: string;
    code: string;
    type: 'PERCENT' | 'FLAT' | 'CASHBACK';
    value: number;
    maxDiscount?: number;
    minFare?: number;
  };
}

export interface PromoApplicationResult {
  discountAmount: number;
  discountType: 'PERCENT' | 'FLAT' | 'CASHBACK';
  originalFare: number;
  discountedFare: number;
  cashbackAmount?: number;
}

/**
 * Validate a promo code for a user and ride context
 */
export async function validatePromo(params: {
  code: string;
  userId: string;
  vehicleType?: string;
  city?: string;
  fare?: number;
}): Promise<PromoValidationResult> {
  const { code, userId, vehicleType, city, fare } = params;

  try {
    const promo = await prisma.promo.findUnique({
      where: { code: code.toUpperCase() },
      include: {
        usages: {
          where: { userId },
        },
        _count: {
          select: { usages: true },
        },
      },
    });

    if (!promo) {
      return { valid: false, error: 'Invalid promo code' };
    }

    if (!promo.isActive) {
      return { valid: false, error: 'This promo code is no longer active' };
    }

    const now = new Date();
    if (now < promo.validFrom) {
      return { valid: false, error: 'This promo code is not yet valid' };
    }

    if (promo.validTo && now > promo.validTo) {
      return { valid: false, error: 'This promo code has expired' };
    }

    // Check usage limits
    if (promo.usageLimit && promo._count.usages >= promo.usageLimit) {
      return { valid: false, error: 'This promo code has reached its usage limit' };
    }

    // Check per-user limit
    if (promo.usages.length >= promo.perUserLimit) {
      return { valid: false, error: 'You have already used this promo code' };
    }

    // Check first ride only
    if (promo.isFirstRideOnly) {
      const userRideCount = await prisma.ride.count({
        where: {
          passengerId: userId,
          status: 'RIDE_COMPLETED',
        },
      });
      if (userRideCount > 0) {
        return { valid: false, error: 'This promo code is only valid for first rides' };
      }
    }

    // Check vehicle type restriction
    if (promo.vehicleTypes.length > 0 && vehicleType) {
      if (!promo.vehicleTypes.includes(vehicleType.toLowerCase())) {
        return { valid: false, error: `This promo code is not valid for ${vehicleType}` };
      }
    }

    // Check city restriction
    if (promo.cities.length > 0 && city) {
      if (!promo.cities.includes(city.toLowerCase())) {
        return { valid: false, error: `This promo code is not valid in ${city}` };
      }
    }

    // Check minimum fare
    if (promo.minFare && fare && fare < promo.minFare) {
      return { valid: false, error: `Minimum fare of ₹${promo.minFare} required for this promo` };
    }

    logger.info(`[PROMO] Validated code ${code} for user ${userId}`);

    return {
      valid: true,
      promo: {
        id: promo.id,
        code: promo.code,
        type: promo.type as 'PERCENT' | 'FLAT' | 'CASHBACK',
        value: promo.value,
        maxDiscount: promo.maxDiscount || undefined,
        minFare: promo.minFare || undefined,
      },
    };
  } catch (error) {
    logger.error('[PROMO] Validation error', { error });
    return { valid: false, error: 'Failed to validate promo code' };
  }
}

/**
 * Calculate discount amount for a promo
 */
export function calculatePromoDiscount(params: {
  promoType: 'PERCENT' | 'FLAT' | 'CASHBACK';
  promoValue: number;
  maxDiscount?: number;
  fare: number;
}): PromoApplicationResult {
  const { promoType, promoValue, maxDiscount, fare } = params;

  let discountAmount = 0;
  let cashbackAmount: number | undefined;

  switch (promoType) {
    case 'PERCENT':
      discountAmount = (fare * promoValue) / 100;
      if (maxDiscount && discountAmount > maxDiscount) {
        discountAmount = maxDiscount;
      }
      break;

    case 'FLAT':
      discountAmount = Math.min(promoValue, fare);
      break;

    case 'CASHBACK':
      // Cashback doesn't reduce fare, it's credited to wallet after ride
      cashbackAmount = promoValue;
      if (maxDiscount && cashbackAmount > maxDiscount) {
        cashbackAmount = maxDiscount;
      }
      discountAmount = 0;
      break;
  }

  const discountedFare = Math.max(0, fare - discountAmount);

  return {
    discountAmount: Math.round(discountAmount * 100) / 100,
    discountType: promoType,
    originalFare: fare,
    discountedFare: Math.round(discountedFare * 100) / 100,
    cashbackAmount,
  };
}

/**
 * Record promo usage after ride completion
 */
export async function recordPromoUsage(params: {
  promoId: string;
  userId: string;
  rideId: string;
}): Promise<void> {
  try {
    await prisma.promoUsage.create({
      data: {
        promoId: params.promoId,
        userId: params.userId,
        rideId: params.rideId,
      },
    });
    logger.info(`[PROMO] Recorded usage for promo ${params.promoId}, ride ${params.rideId}`);
  } catch (error) {
    logger.error('[PROMO] Failed to record usage', { error, params });
  }
}

/**
 * Get active promos for a user (for display in app)
 */
export async function getActivePromosForUser(params: {
  userId: string;
  vehicleType?: string;
  city?: string;
}): Promise<Array<{
  code: string;
  description: string;
  type: string;
  value: number;
  maxDiscount?: number;
  minFare?: number;
  validTo?: Date;
}>> {
  try {
    const now = new Date();
    const promos = await prisma.promo.findMany({
      where: {
        isActive: true,
        validFrom: { lte: now },
        OR: [
          { validTo: null },
          { validTo: { gte: now } },
        ],
      },
      include: {
        usages: {
          where: { userId: params.userId },
        },
        _count: {
          select: { usages: true },
        },
      },
    });

    return promos
      .filter((p) => {
        // Filter out used promos
        if (p.usages.length >= p.perUserLimit) return false;
        // Filter out exhausted promos
        if (p.usageLimit && p._count.usages >= p.usageLimit) return false;
        // Filter by vehicle type
        if (p.vehicleTypes.length > 0 && params.vehicleType) {
          if (!p.vehicleTypes.includes(params.vehicleType.toLowerCase())) return false;
        }
        // Filter by city
        if (p.cities.length > 0 && params.city) {
          if (!p.cities.includes(params.city.toLowerCase())) return false;
        }
        return true;
      })
      .map((p) => ({
        code: p.code,
        description: getPromoDescription(p.type as any, p.value, p.maxDiscount),
        type: p.type,
        value: p.value,
        maxDiscount: p.maxDiscount || undefined,
        minFare: p.minFare || undefined,
        validTo: p.validTo || undefined,
      }));
  } catch (error) {
    logger.error('[PROMO] Failed to get active promos', { error });
    return [];
  }
}

function getPromoDescription(type: 'PERCENT' | 'FLAT' | 'CASHBACK', value: number, maxDiscount?: number | null): string {
  switch (type) {
    case 'PERCENT':
      return maxDiscount
        ? `${value}% off (up to ₹${maxDiscount})`
        : `${value}% off`;
    case 'FLAT':
      return `₹${value} off`;
    case 'CASHBACK':
      return maxDiscount
        ? `₹${value} cashback (up to ₹${maxDiscount})`
        : `₹${value} cashback`;
  }
}
