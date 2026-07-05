import { prisma, createLogger } from '@raahi/shared';
import { BannerPlacement } from '@prisma/client';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import path from 'path';

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

const AWS_S3_REGION = process.env.AWS_S3_REGION;
const AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

function isS3Configured(): boolean {
  return !!(AWS_S3_REGION && AWS_S3_BUCKET && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY);
}

let s3Client: S3Client | null = null;
if (isS3Configured()) {
  s3Client = new S3Client({
    region: AWS_S3_REGION!,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID!,
      secretAccessKey: AWS_SECRET_ACCESS_KEY!,
    },
  });
}

function extractS3Key(imageUrl: string): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('/uploads/banners/')) {
    return imageUrl.replace(/^\/uploads\/banners\//, 'banners/');
  }
  try {
    const url = new URL(imageUrl);
    const key = url.pathname.replace(/^\/+/, '');
    return key || null;
  } catch {
    return null;
  }
}

function contentTypeForKey(key: string): string {
  const ext = path.extname(key).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.jpg':
    case '.jpeg':
    default:
      return 'image/jpeg';
  }
}

export function bannerImageProxyUrl(bannerId: string): string {
  return `/api/banners/image/${bannerId}`;
}

/** Stream banner bytes (private S3 or admin-service local disk). */
export async function getBannerImagePayload(
  bannerId: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  const banner = await prisma.banner.findUnique({ where: { id: bannerId } });
  if (!banner?.imageUrl) return null;

  const imageUrl = banner.imageUrl;

  if (imageUrl.startsWith('/uploads/banners/')) {
    const adminUrl = process.env.ADMIN_SERVICE_URL || 'http://localhost:5008';
    try {
      const resp = await fetch(`${adminUrl}${imageUrl}`);
      if (!resp.ok) return null;
      const buffer = Buffer.from(await resp.arrayBuffer());
      return { buffer, contentType: resp.headers.get('content-type') || contentTypeForKey(imageUrl) };
    } catch (err: any) {
      logger.warn(`[BANNER] Local image fetch failed ${bannerId}: ${err?.message || err}`);
      return null;
    }
  }

  if (!isS3Configured() || !s3Client) {
    logger.warn('[BANNER] Cannot load image: S3 not configured');
    return null;
  }

  const key = extractS3Key(imageUrl);
  if (!key) return null;

  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: AWS_S3_BUCKET!,
        Key: key,
      }),
    );
    if (!response.Body) return null;

    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return {
      buffer: Buffer.concat(chunks),
      contentType: response.ContentType || contentTypeForKey(key),
    };
  } catch (err: any) {
    logger.error(`[BANNER] Failed to load image ${bannerId}: ${err?.message || err}`);
    return null;
  }
}
