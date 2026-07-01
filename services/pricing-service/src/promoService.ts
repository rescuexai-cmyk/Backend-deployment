/**
 * Promo Service
 *
 * DB-backed promo/coupon codes. Promo definitions live in the `promos` table and
 * are editable at runtime via the admin API (see index.ts), so marketing can add
 * or change discounts daily WITHOUT shipping a new app build — the client only
 * ever sends the typed code and renders whatever the server returns.
 *
 * Enforcement happens entirely server-side:
 *   - active window (isActive + validFrom/validTo)
 *   - vehicle-type / city restrictions
 *   - minimum fare
 *   - first-ride-only (no prior completed rides)
 *   - global usage limit + per-user limit (via promo_usages)
 */

import { prisma, createLogger } from '@raahi/shared';

const logger = createLogger('promo-service');

type PromoTypeStr = 'PERCENT' | 'FLAT' | 'CASHBACK';

interface PromoRecord {
  id: string;
  code: string;
  type: PromoTypeStr;
  value: number;
  maxDiscount: number | null;
  minFare: number | null;
  usageLimit: number | null;
  perUserLimit: number;
  validFrom: Date;
  validTo: Date | null;
  vehicleTypes: string[];
  cities: string[];
  isFirstRideOnly: boolean;
  isActive: boolean;
}

// ─── Cache of active promo DEFINITIONS (not usage counts) ────────────────────
// Usage counts are always read fresh so limits are enforced accurately; only the
// promo rows themselves are cached to spare the DB on the hot "active promos" path.
const PROMO_CACHE_TTL_MS = Number(process.env.PROMO_CACHE_TTL_MS ?? 60_000);
let promoCache: { data: PromoRecord[]; expiresAt: number } | null = null;
let inflight: Promise<PromoRecord[]> | null = null;

export function invalidatePromoCache(): void {
  promoCache = null;
}

async function loadActivePromos(): Promise<PromoRecord[]> {
  const now = Date.now();
  if (promoCache && promoCache.expiresAt > now) return promoCache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    const nowDate = new Date();
    const rows = (await prisma.promo.findMany({
      where: {
        isActive: true,
        validFrom: { lte: nowDate },
        OR: [{ validTo: null }, { validTo: { gte: nowDate } }],
      },
    })) as unknown as PromoRecord[];
    promoCache = { data: rows, expiresAt: Date.now() + PROMO_CACHE_TTL_MS };
    return rows;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export interface PromoValidationResult {
  valid: boolean;
  error?: string;
  promo?: {
    id: string;
    code: string;
    type: PromoTypeStr;
    value: number;
    maxDiscount?: number;
    minFare?: number;
  };
}

export interface PromoApplicationResult {
  discountAmount: number;
  discountType: PromoTypeStr;
  originalFare: number;
  discountedFare: number;
  cashbackAmount?: number;
}

async function userHasCompletedRide(userId: string): Promise<boolean> {
  const count = await prisma.ride.count({
    where: { passengerId: userId, status: 'RIDE_COMPLETED' as any },
  });
  return count > 0;
}

/**
 * Validate a promo code for a user and ride context.
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
    const wanted = code.trim().toUpperCase();
    const promos = await loadActivePromos();
    const promo = promos.find((p) => p.code.toUpperCase() === wanted);

    if (!promo) {
      return { valid: false, error: 'Invalid or expired promo code' };
    }

    if (promo.vehicleTypes.length > 0 && vehicleType) {
      if (!promo.vehicleTypes.includes(vehicleType.toLowerCase())) {
        return { valid: false, error: `This promo code is not valid for ${vehicleType}` };
      }
    }

    if (promo.cities.length > 0 && city) {
      if (!promo.cities.includes(city.toLowerCase())) {
        return { valid: false, error: `This promo code is not valid in ${city}` };
      }
    }

    if (promo.minFare && fare != null && fare < promo.minFare) {
      return { valid: false, error: `Minimum fare of ₹${promo.minFare} required for this promo` };
    }

    if (promo.isFirstRideOnly && (await userHasCompletedRide(userId))) {
      return { valid: false, error: 'This code is valid on your first ride only' };
    }

    // Global usage cap
    if (promo.usageLimit != null) {
      const total = await prisma.promoUsage.count({ where: { promoId: promo.id } });
      if (total >= promo.usageLimit) {
        return { valid: false, error: 'This promo code is no longer available' };
      }
    }

    // Per-user cap
    const userUses = await prisma.promoUsage.count({ where: { promoId: promo.id, userId } });
    if (userUses >= promo.perUserLimit) {
      return { valid: false, error: 'You have already used this promo code' };
    }

    logger.info(`[PROMO] Validated code ${promo.code} for user ${userId}`);

    return {
      valid: true,
      promo: {
        id: promo.id,
        code: promo.code,
        type: promo.type,
        value: promo.value,
        maxDiscount: promo.maxDiscount ?? undefined,
        minFare: promo.minFare ?? undefined,
      },
    };
  } catch (error) {
    logger.error('[PROMO] Validation error', { error });
    return { valid: false, error: 'Failed to validate promo code' };
  }
}

/**
 * Calculate discount amount for a promo (pure function — no DB).
 */
export function calculatePromoDiscount(params: {
  promoType: PromoTypeStr;
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
 * Record promo redemption. Called at booking time so per-user / global limits
 * are enforced on subsequent validations. The unique (promoId,userId,rideId)
 * index makes this idempotent per ride.
 *
 * @returns true if a new usage row was written, false if it was a duplicate.
 */
export async function recordPromoUsage(params: {
  promoId: string;
  userId: string;
  rideId: string;
}): Promise<boolean> {
  const { promoId, userId, rideId } = params;
  try {
    await prisma.promoUsage.create({ data: { promoId, userId, rideId } });
    logger.info(`[PROMO] Recorded usage promo=${promoId} user=${userId} ride=${rideId}`);
    return true;
  } catch (error: any) {
    if (error?.code === 'P2002') {
      logger.warn(`[PROMO] Duplicate usage ignored promo=${promoId} ride=${rideId}`);
      return false;
    }
    logger.error('[PROMO] Failed to record usage', { error });
    throw error;
  }
}

/**
 * Validate a promo for the booking flow, compute the discount, and (if a rideId
 * is supplied) record the redemption.
 *
 * - Omit `rideId` for a dry-run (validate + price, no usage recorded) — used to
 *   reject bad codes and show the discount BEFORE the ride row exists.
 * - Pass `rideId` to record the redemption (idempotent per ride).
 */
export async function redeemPromo(params: {
  code: string;
  userId: string;
  rideId?: string;
  vehicleType?: string;
  city?: string;
  fare?: number;
}): Promise<PromoValidationResult & { recorded?: boolean; discount?: PromoApplicationResult }> {
  const validation = await validatePromo(params);
  if (!validation.valid || !validation.promo) return validation;

  const discount =
    params.fare != null
      ? calculatePromoDiscount({
          promoType: validation.promo.type,
          promoValue: validation.promo.value,
          maxDiscount: validation.promo.maxDiscount,
          fare: params.fare,
        })
      : undefined;

  let recorded = false;
  if (params.rideId) {
    recorded = await recordPromoUsage({
      promoId: validation.promo.id,
      userId: params.userId,
      rideId: params.rideId,
    });
  }

  return { ...validation, recorded, discount };
}

/**
 * Get active promos for a user (for display in app).
 */
export async function getActivePromosForUser(params: {
  userId: string;
  vehicleType?: string;
  city?: string;
}): Promise<
  Array<{
    code: string;
    description: string;
    type: string;
    value: number;
    maxDiscount?: number;
    minFare?: number;
  }>
> {
  const { userId, vehicleType, city } = params;
  const promos = await loadActivePromos();

  const candidates = promos.filter((p) => {
    if (p.vehicleTypes.length > 0 && vehicleType) {
      if (!p.vehicleTypes.includes(vehicleType.toLowerCase())) return false;
    }
    if (p.cities.length > 0 && city) {
      if (!p.cities.includes(city.toLowerCase())) return false;
    }
    return true;
  });

  if (candidates.length === 0) return [];

  const ids = candidates.map((p) => p.id);

  // One query for this user's usage counts, one for global totals.
  const [userGroups, totalGroups, hasCompleted] = await Promise.all([
    prisma.promoUsage.groupBy({
      by: ['promoId'],
      where: { userId, promoId: { in: ids } },
      _count: { _all: true },
    }),
    prisma.promoUsage.groupBy({
      by: ['promoId'],
      where: { promoId: { in: ids } },
      _count: { _all: true },
    }),
    candidates.some((p) => p.isFirstRideOnly) ? userHasCompletedRide(userId) : Promise.resolve(false),
  ]);

  const userCount = new Map(userGroups.map((g: any) => [g.promoId, g._count._all]));
  const totalCount = new Map(totalGroups.map((g: any) => [g.promoId, g._count._all]));

  return candidates
    .filter((p) => {
      if (p.isFirstRideOnly && hasCompleted) return false;
      if ((userCount.get(p.id) ?? 0) >= p.perUserLimit) return false;
      if (p.usageLimit != null && (totalCount.get(p.id) ?? 0) >= p.usageLimit) return false;
      return true;
    })
    .map((p) => ({
      code: p.code,
      description: getPromoDescription(p.type, p.value, p.maxDiscount ?? undefined),
      type: p.type,
      value: p.value,
      maxDiscount: p.maxDiscount ?? undefined,
      minFare: p.minFare ?? undefined,
    }));
}

function getPromoDescription(type: PromoTypeStr, value: number, maxDiscount?: number): string {
  switch (type) {
    case 'PERCENT':
      return maxDiscount ? `${value}% off (up to ₹${maxDiscount})` : `${value}% off`;
    case 'FLAT':
      return `₹${value} off`;
    case 'CASHBACK':
      return maxDiscount ? `₹${value} cashback (up to ₹${maxDiscount})` : `₹${value} cashback`;
  }
}
