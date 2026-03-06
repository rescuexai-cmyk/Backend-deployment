/**
 * Promo Service
 * Handles promo code validation, application, and usage tracking
 * 
 * NOTE: Full Prisma integration requires migration. This version uses
 * static promos until DB is ready, then can be updated to use Prisma.
 */

import { createLogger } from '@raahi/shared';

const logger = createLogger('promo-service');

// Static promos for initial launch (can be moved to DB after migration)
const STATIC_PROMOS: Array<{
  id: string;
  code: string;
  type: 'PERCENT' | 'FLAT' | 'CASHBACK';
  value: number;
  maxDiscount?: number;
  minFare?: number;
  vehicleTypes: string[];
  cities: string[];
  isFirstRideOnly: boolean;
  isActive: boolean;
}> = [
  {
    id: 'promo_first50',
    code: 'FIRST50',
    type: 'PERCENT',
    value: 50,
    maxDiscount: 100,
    minFare: 99,
    vehicleTypes: [],
    cities: [],
    isFirstRideOnly: true,
    isActive: true,
  },
  {
    id: 'promo_raahi20',
    code: 'RAAHI20',
    type: 'PERCENT',
    value: 20,
    maxDiscount: 50,
    minFare: 149,
    vehicleTypes: [],
    cities: [],
    isFirstRideOnly: false,
    isActive: true,
  },
  {
    id: 'promo_flat30',
    code: 'FLAT30',
    type: 'FLAT',
    value: 30,
    minFare: 199,
    vehicleTypes: [],
    cities: [],
    isFirstRideOnly: false,
    isActive: true,
  },
];

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
    // Find promo in static list
    const promo = STATIC_PROMOS.find(
      (p) => p.code.toUpperCase() === code.toUpperCase() && p.isActive
    );

    if (!promo) {
      return { valid: false, error: 'Invalid promo code' };
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
        type: promo.type,
        value: promo.value,
        maxDiscount: promo.maxDiscount,
        minFare: promo.minFare,
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
 * TODO: Implement with Prisma after migration
 */
export async function recordPromoUsage(params: {
  promoId: string;
  userId: string;
  rideId: string;
}): Promise<void> {
  logger.info(`[PROMO] Recording usage for promo ${params.promoId}, ride ${params.rideId}`);
  // Will be implemented with Prisma after migration
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
}>> {
  return STATIC_PROMOS
    .filter((p) => {
      if (!p.isActive) return false;
      if (p.vehicleTypes.length > 0 && params.vehicleType) {
        if (!p.vehicleTypes.includes(params.vehicleType.toLowerCase())) return false;
      }
      if (p.cities.length > 0 && params.city) {
        if (!p.cities.includes(params.city.toLowerCase())) return false;
      }
      return true;
    })
    .map((p) => ({
      code: p.code,
      description: getPromoDescription(p.type, p.value, p.maxDiscount),
      type: p.type,
      value: p.value,
      maxDiscount: p.maxDiscount,
      minFare: p.minFare,
    }));
}

function getPromoDescription(type: 'PERCENT' | 'FLAT' | 'CASHBACK', value: number, maxDiscount?: number): string {
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
