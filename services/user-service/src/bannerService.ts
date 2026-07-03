import { prisma, createLogger } from '@raahi/shared';
import { BannerPlacement } from '@prisma/client';

const logger = createLogger('banner-service');

/** Fixed in-app banner slot (320×120). Exposed in API so clients lay out carousels correctly. */
export const BANNER_WIDTH = 320;
export const BANNER_HEIGHT = 120;

const BANNER_CACHE_TTL_MS = Number(process.env.BANNER_CACHE_TTL_MS ?? 60_000);
let bannerCache: Map<string, { data: any[]; expiresAt: number }> = new Map();
let inflight: Map<string, Promise<any[]>> = new Map();

export function invalidateBannerCache(): void {
  bannerCache.clear();
}

const PLACEMENTS = new Set<string>(['HOME', 'RIDES', 'PROFILE']);

export function normalizePlacement(value?: string): BannerPlacement {
  const upper = String(value || 'HOME').toUpperCase();
  return (PLACEMENTS.has(upper) ? upper : 'HOME') as BannerPlacement;
}

export async function getActiveBanners(placement: BannerPlacement, city?: string): Promise<any[]> {
  const cacheKey = `${placement}:${(city || '').toLowerCase()}`;
  const now = Date.now();
  const cached = bannerCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data;

  let promise = inflight.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      const nowDate = new Date();
      const cityNorm = city?.trim().toLowerCase();
      const rows = await prisma.banner.findMany({
        where: {
          placement,
          isActive: true,
          validFrom: { lte: nowDate },
          OR: [{ validTo: null }, { validTo: { gte: nowDate } }],
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      });

      const filtered = cityNorm
        ? rows.filter((b) => !b.cities.length || b.cities.map((c) => c.toLowerCase()).includes(cityNorm))
        : rows;

      bannerCache.set(cacheKey, { data: filtered, expiresAt: Date.now() + BANNER_CACHE_TTL_MS });
      return filtered;
    })();
    inflight.set(cacheKey, promise);
  }

  try {
    return await promise;
  } finally {
    inflight.delete(cacheKey);
  }
}

export async function listAllBanners(): Promise<any[]> {
  return prisma.banner.findMany({
    orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });
}

export async function createBanner(data: {
  title: string;
  imageUrl: string;
  linkUrl?: string | null;
  placement: BannerPlacement;
  sortOrder?: number;
  validFrom?: Date;
  validTo?: Date | null;
  cities?: string[];
  isActive?: boolean;
}): Promise<any> {
  const banner = await prisma.banner.create({
    data: {
      title: data.title,
      imageUrl: data.imageUrl,
      linkUrl: data.linkUrl ?? null,
      placement: data.placement,
      sortOrder: data.sortOrder ?? 0,
      validFrom: data.validFrom ?? new Date(),
      validTo: data.validTo ?? null,
      cities: (data.cities || []).map((c) => c.toLowerCase()),
      isActive: data.isActive ?? true,
    },
  });
  invalidateBannerCache();
  logger.info(`[BANNER] Created: ${banner.id} (${banner.placement})`);
  return banner;
}

export async function updateBanner(id: string, data: Record<string, any>): Promise<any> {
  const patch: Record<string, any> = {};
  if (data.title !== undefined) patch.title = data.title;
  if (data.imageUrl !== undefined) patch.imageUrl = data.imageUrl;
  if (data.linkUrl !== undefined) patch.linkUrl = data.linkUrl || null;
  if (data.placement !== undefined) patch.placement = normalizePlacement(data.placement);
  if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;
  if (data.validFrom !== undefined) patch.validFrom = new Date(data.validFrom);
  if (data.validTo !== undefined) patch.validTo = data.validTo ? new Date(data.validTo) : null;
  if (data.cities !== undefined) patch.cities = (data.cities || []).map((c: string) => c.toLowerCase());
  if (data.isActive !== undefined) patch.isActive = data.isActive;

  const banner = await prisma.banner.update({ where: { id }, data: patch });
  invalidateBannerCache();
  logger.info(`[BANNER] Updated: ${id}`);
  return banner;
}

export async function deleteBanner(id: string): Promise<void> {
  await prisma.banner.delete({ where: { id } });
  invalidateBannerCache();
  logger.info(`[BANNER] Deleted: ${id}`);
}
