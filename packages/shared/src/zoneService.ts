/**
 * Zone resolution service.
 *
 * Resolves a coordinate to an operational zone using H3 geofences (a set of H3
 * cells per zone), which is fast and deterministic and needs no PostGIS. When a
 * location isn't covered by any defined zone, it gracefully falls back to
 * reverse-geocoded city detection so the platform keeps working while zones are
 * being rolled out city-by-city.
 *
 * This is the industry-standard pattern for permit/surge/geofence zones in a
 * ride-hailing marketplace: define zones once (from GeoJSON), then do O(1)
 * point-in-zone lookups on every quote/booking.
 */

import { prisma } from './database';
import { latLngToH3, polygonToCells, circleToCells } from './h3Utils';
import { getCityFromCoordinates, normalizeCity } from './cityUtils';
import { createLogger } from './logger';

const logger = createLogger('zone-service');

// Resolution used to tile zones. res-8 hexes are ~0.74 km² (~460m edge), giving
// ~sub-km border accuracy while keeping a metro to a few thousand cells — cheap
// to store and cache. Must match the zone seed (prisma/seed-zones.js).
export const ZONE_H3_RESOLUTION = Number(process.env.ZONE_H3_RESOLUTION ?? 8);

const ZONE_CELL_CACHE_TTL_MS = Number(process.env.ZONE_CELL_CACHE_TTL_MS ?? 10 * 60 * 1000);
const ZONE_RESOLVE_CACHE_TTL_MS = Number(process.env.ZONE_RESOLVE_CACHE_TTL_MS ?? 5 * 60 * 1000);
const ZONE_RESOLVE_CACHE_MAX = 10000;

// h3Index -> zoneCode, loaded from DB once per TTL (zone geometry is small & static).
let zoneCellCache: { map: Map<string, string>; expiresAt: number } | null = null;
let zoneCellInflight: Promise<Map<string, string>> | null = null;

// Resolved location cache keyed by rounded coords, to dedupe hot-path lookups.
const resolveCache = new Map<string, { zone: string; expiresAt: number }>();

function resolveCacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

async function loadZoneCells(): Promise<Map<string, string>> {
  if (zoneCellCache && zoneCellCache.expiresAt > Date.now()) {
    return zoneCellCache.map;
  }
  if (zoneCellInflight) return zoneCellInflight;

  zoneCellInflight = (async () => {
    try {
      const cells = await prisma.zoneCell.findMany({
        where: { zone: { isActive: true } },
        select: { h3Index: true, zone: { select: { code: true } } },
      });
      const map = new Map<string, string>();
      for (const c of cells) {
        map.set(c.h3Index, normalizeCity(c.zone.code));
      }
      zoneCellCache = { map, expiresAt: Date.now() + ZONE_CELL_CACHE_TTL_MS };
      return map;
    } catch (error) {
      // If zone tables aren't migrated yet, behave as "no zones defined".
      logger.warn('[ZONE] Failed to load zone cells, falling back to geocode', {
        error: (error as Error).message,
      });
      const empty = new Map<string, string>();
      zoneCellCache = { map: empty, expiresAt: Date.now() + ZONE_CELL_CACHE_TTL_MS };
      return empty;
    } finally {
      zoneCellInflight = null;
    }
  })();

  return zoneCellInflight;
}

/** Invalidate the in-process zone geometry cache after zone edits. */
export function invalidateZoneCache(): void {
  zoneCellCache = null;
  resolveCache.clear();
}

/**
 * Resolve a coordinate to a normalized zone code.
 * Uses H3 geofence lookup first, then falls back to reverse-geocoded city.
 */
export async function resolveZone(lat: number, lng: number): Promise<string> {
  const key = resolveCacheKey(lat, lng);
  const cached = resolveCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.zone;
  }

  let zone: string | null = null;
  try {
    const cells = await loadZoneCells();
    if (cells.size > 0) {
      const h3Index = latLngToH3(lat, lng, ZONE_H3_RESOLUTION);
      zone = cells.get(h3Index) ?? null;
    }
  } catch (error) {
    logger.warn('[ZONE] Geofence lookup failed, falling back to geocode', {
      error: (error as Error).message,
    });
  }

  // Fallback: reverse geocode to a city slug (keeps behavior during rollout).
  if (!zone) {
    zone = await getCityFromCoordinates(lat, lng);
  }

  if (resolveCache.size >= ZONE_RESOLVE_CACHE_MAX) {
    resolveCache.clear();
  }
  resolveCache.set(key, { zone, expiresAt: Date.now() + ZONE_RESOLVE_CACHE_TTL_MS });
  return zone;
}

export interface UpsertZoneInput {
  code: string;
  name: string;
  type?: string;
  /** GeoJSON polygon rings ([lng,lat]); first ring outer, rest holes. */
  polygon?: number[][][] | number[][];
  /** Alternative to polygon: approximate circular area. */
  circle?: { lat: number; lng: number; radiusKm: number };
  /** Alternative: explicit H3 cells (at ZONE_H3_RESOLUTION). */
  h3Cells?: string[];
}

/**
 * Create or replace a zone and its H3 cell set from a polygon, circle, or
 * explicit cell list. Idempotent per zone code.
 */
export async function upsertZoneGeofence(input: UpsertZoneInput): Promise<{
  code: string;
  cellCount: number;
}> {
  const code = normalizeCity(input.code);

  let cells: string[] = [];
  if (input.h3Cells && input.h3Cells.length > 0) {
    cells = input.h3Cells;
  } else if (input.polygon) {
    cells = polygonToCells(input.polygon, ZONE_H3_RESOLUTION, true);
  } else if (input.circle) {
    cells = circleToCells(input.circle.lat, input.circle.lng, input.circle.radiusKm, ZONE_H3_RESOLUTION);
  }

  const uniqueCells = Array.from(new Set(cells));
  if (uniqueCells.length === 0) {
    throw new Error('Zone must define geometry via polygon, circle, or h3Cells');
  }

  await prisma.$transaction(async (tx) => {
    const zone = await tx.zone.upsert({
      where: { code },
      update: { name: input.name, type: input.type ?? 'city', isActive: true },
      create: { code, name: input.name, type: input.type ?? 'city' },
    });

    // Replace the cell set atomically. Cells are globally unique, so we detach
    // any cells currently pointing elsewhere before reassigning them here.
    await tx.zoneCell.deleteMany({ where: { zoneId: zone.id } });
    await tx.zoneCell.deleteMany({ where: { h3Index: { in: uniqueCells } } });
    await tx.zoneCell.createMany({
      data: uniqueCells.map((h3Index) => ({ zoneId: zone.id, h3Index })),
      skipDuplicates: true,
    });
  });

  invalidateZoneCache();
  logger.info(`[ZONE] Upserted zone '${code}' with ${uniqueCells.length} cells`);
  return { code, cellCount: uniqueCells.length };
}

export async function deleteZone(code: string): Promise<void> {
  await prisma.zone.delete({ where: { code: normalizeCity(code) } });
  invalidateZoneCache();
}

export async function listZones(): Promise<
  Array<{ id: string; code: string; name: string; type: string; isActive: boolean; cellCount: number }>
> {
  const zones = await prisma.zone.findMany({
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      isActive: true,
      _count: { select: { cells: true } },
    },
  });
  return zones.map((z) => ({
    id: z.id,
    code: z.code,
    name: z.name,
    type: z.type,
    isActive: z.isActive,
    cellCount: z._count.cells,
  }));
}
