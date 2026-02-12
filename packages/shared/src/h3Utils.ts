/**
 * H3 Geospatial Indexing Utilities
 * 
 * Uses Uber's H3 hexagonal hierarchical spatial index for efficient
 * geospatial driver matching in ride-hailing applications.
 * 
 * Key concepts:
 * - Resolution 8: ~460m edge length, good for city-level accuracy
 * - Resolution 9: ~174m edge length, good for neighborhood-level accuracy
 * - kRing: Returns all hexagons within k "rings" of a given hexagon
 * 
 * @see https://h3geo.org/docs/core-library/restable
 */

import * as h3 from 'h3-js';
import { createLogger } from './logger';

const logger = createLogger('h3-utils');

// Default H3 resolution (configurable via env)
// Resolution 8: ~460m edge, ~0.74 km² area - good for urban areas
// Resolution 9: ~174m edge, ~0.11 km² area - good for dense urban areas
const DEFAULT_H3_RESOLUTION = 9;
const H3_RESOLUTION = parseInt(process.env.H3_RESOLUTION || String(DEFAULT_H3_RESOLUTION), 10);

// Maximum kRing expansion for driver search
const DEFAULT_MAX_K_RING = 3;
const MAX_K_RING = parseInt(process.env.H3_MAX_K_RING || String(DEFAULT_MAX_K_RING), 10);

// Approximate edge length in km for each resolution
const H3_EDGE_LENGTH_KM: Record<number, number> = {
  7: 1.22,   // ~1.2 km edge
  8: 0.46,   // ~460m edge
  9: 0.17,   // ~170m edge
  10: 0.065, // ~65m edge
};

export interface H3Config {
  resolution: number;
  maxKRing: number;
  edgeLengthKm: number;
}

/**
 * Get current H3 configuration
 */
export function getH3Config(): H3Config {
  return {
    resolution: H3_RESOLUTION,
    maxKRing: MAX_K_RING,
    edgeLengthKm: H3_EDGE_LENGTH_KM[H3_RESOLUTION] || 0.17,
  };
}

/**
 * Convert latitude/longitude to H3 index
 * 
 * @param lat - Latitude in decimal degrees
 * @param lng - Longitude in decimal degrees
 * @param resolution - Optional custom resolution (defaults to configured)
 * @returns H3 index string (e.g., "8928308280fffff")
 */
export function latLngToH3(lat: number, lng: number, resolution?: number): string {
  const res = resolution ?? H3_RESOLUTION;
  
  // Validate inputs
  if (lat < -90 || lat > 90) {
    throw new Error(`Invalid latitude: ${lat}. Must be between -90 and 90.`);
  }
  if (lng < -180 || lng > 180) {
    throw new Error(`Invalid longitude: ${lng}. Must be between -180 and 180.`);
  }
  
  return h3.latLngToCell(lat, lng, res);
}

/**
 * Convert H3 index back to center latitude/longitude
 * 
 * @param h3Index - H3 index string
 * @returns [latitude, longitude] tuple
 */
export function h3ToLatLng(h3Index: string): [number, number] {
  if (!h3.isValidCell(h3Index)) {
    throw new Error(`Invalid H3 index: ${h3Index}`);
  }
  return h3.cellToLatLng(h3Index);
}

/**
 * Get all H3 cells within k rings of a center cell
 * 
 * kRing distance meanings at resolution 9:
 * - k=0: Just the center cell (~0.11 km²)
 * - k=1: Center + 6 surrounding cells (~0.77 km² area, ~500m radius)
 * - k=2: 19 total cells (~2.1 km² area, ~800m radius)
 * - k=3: 37 total cells (~4.1 km² area, ~1.2km radius)
 * 
 * @param h3Index - Center H3 index
 * @param k - Number of rings (0 = just center, 1 = center + neighbors, etc.)
 * @returns Array of H3 index strings
 */
export function getKRing(h3Index: string, k: number): string[] {
  if (!h3.isValidCell(h3Index)) {
    throw new Error(`Invalid H3 index: ${h3Index}`);
  }
  if (k < 0) {
    throw new Error(`Invalid k value: ${k}. Must be >= 0.`);
  }
  
  return h3.gridDisk(h3Index, k);
}

/**
 * Check if an H3 cell is within k rings of another cell
 * 
 * @param targetH3 - The H3 index to check
 * @param centerH3 - The center H3 index
 * @param k - Maximum ring distance
 * @returns true if targetH3 is within k rings of centerH3
 */
export function isWithinKRing(targetH3: string, centerH3: string, k: number): boolean {
  const ring = getKRing(centerH3, k);
  return ring.includes(targetH3);
}

/**
 * Get the distance in grid cells between two H3 cells
 * 
 * @param h3a - First H3 index
 * @param h3b - Second H3 index
 * @returns Grid distance (number of cells), or -1 if not comparable
 */
export function getGridDistance(h3a: string, h3b: string): number {
  try {
    return h3.gridDistance(h3a, h3b);
  } catch {
    // Cells might be at different resolutions or too far apart
    return -1;
  }
}

/**
 * Validate an H3 index string
 * 
 * @param h3Index - H3 index to validate
 * @returns true if valid
 */
export function isValidH3Index(h3Index: string): boolean {
  return h3.isValidCell(h3Index);
}

/**
 * Get the resolution of an H3 index
 * 
 * @param h3Index - H3 index
 * @returns Resolution (0-15)
 */
export function getH3Resolution(h3Index: string): number {
  return h3.getResolution(h3Index);
}

/**
 * Estimate the approximate radius in km covered by k rings at the configured resolution
 * 
 * @param k - Number of rings
 * @returns Approximate radius in kilometers
 */
export function estimateKRingRadiusKm(k: number): number {
  const edgeLength = H3_EDGE_LENGTH_KM[H3_RESOLUTION] || 0.17;
  // Each ring adds approximately 2 * edgeLength to the radius
  // k=0 covers ~1 cell radius, k=1 covers ~3 cells radius, etc.
  return edgeLength * (2 * k + 1);
}

/**
 * Estimate the number of cells in a kRing
 * 
 * @param k - Number of rings
 * @returns Number of cells (1 for k=0, 7 for k=1, 19 for k=2, etc.)
 */
export function estimateKRingCellCount(k: number): number {
  if (k === 0) return 1;
  // Formula: 3*k*(k+1) + 1
  return 3 * k * (k + 1) + 1;
}

export interface H3MatchResult {
  centerH3: string;
  kRingUsed: number;
  searchCells: string[];
  approximateRadiusKm: number;
}

/**
 * Generate H3 search cells for ride matching with logging
 * 
 * @param lat - Pickup latitude
 * @param lng - Pickup longitude
 * @param initialK - Starting k value (default 1)
 * @param maxK - Maximum k value (default from config)
 * @returns Match result with search cells and metadata
 */
export function generateSearchCells(
  lat: number,
  lng: number,
  initialK: number = 1,
  maxK?: number
): H3MatchResult {
  const effectiveMaxK = maxK ?? MAX_K_RING;
  const centerH3 = latLngToH3(lat, lng);
  const searchCells = getKRing(centerH3, initialK);
  const approximateRadiusKm = estimateKRingRadiusKm(initialK);
  
  logger.debug(`[H3] Generated search cells: center=${centerH3}, k=${initialK}, cells=${searchCells.length}, radius≈${approximateRadiusKm.toFixed(2)}km`);
  
  return {
    centerH3,
    kRingUsed: initialK,
    searchCells,
    approximateRadiusKm,
  };
}

/**
 * Expand search to a larger kRing
 * 
 * @param centerH3 - Center H3 index
 * @param currentK - Current k value
 * @param maxK - Maximum k value
 * @returns Expanded match result or null if at max
 */
export function expandSearch(
  centerH3: string,
  currentK: number,
  maxK?: number
): H3MatchResult | null {
  const effectiveMaxK = maxK ?? MAX_K_RING;
  
  if (currentK >= effectiveMaxK) {
    logger.warn(`[H3] Cannot expand beyond maxK=${effectiveMaxK}`);
    return null;
  }
  
  const newK = currentK + 1;
  const searchCells = getKRing(centerH3, newK);
  const approximateRadiusKm = estimateKRingRadiusKm(newK);
  
  logger.debug(`[H3] Expanded search: center=${centerH3}, k=${currentK}→${newK}, cells=${searchCells.length}, radius≈${approximateRadiusKm.toFixed(2)}km`);
  
  return {
    centerH3,
    kRingUsed: newK,
    searchCells,
    approximateRadiusKm,
  };
}

export interface H3MatchingLog {
  pickupLat: number;
  pickupLng: number;
  pickupH3: string;
  resolution: number;
  iterations: Array<{
    k: number;
    cellCount: number;
    driversFound: number;
    approximateRadiusKm: number;
  }>;
  finalK: number;
  totalDriversFound: number;
  matchingTimeMs: number;
}

/**
 * Create a matching log entry for debugging/monitoring
 */
export function createMatchingLog(
  pickupLat: number,
  pickupLng: number,
  pickupH3: string,
  iterations: Array<{ k: number; cellCount: number; driversFound: number }>,
  matchingTimeMs: number
): H3MatchingLog {
  return {
    pickupLat,
    pickupLng,
    pickupH3,
    resolution: H3_RESOLUTION,
    iterations: iterations.map(iter => ({
      ...iter,
      approximateRadiusKm: estimateKRingRadiusKm(iter.k),
    })),
    finalK: iterations.length > 0 ? iterations[iterations.length - 1].k : 0,
    totalDriversFound: iterations.length > 0 ? iterations[iterations.length - 1].driversFound : 0,
    matchingTimeMs,
  };
}

/**
 * Log the matching process for monitoring
 */
export function logMatchingProcess(log: H3MatchingLog): void {
  logger.info(`[H3-MATCHING] Ride matching completed`, {
    pickup: { lat: log.pickupLat, lng: log.pickupLng },
    h3Index: log.pickupH3,
    resolution: log.resolution,
    finalK: log.finalK,
    totalDriversFound: log.totalDriversFound,
    matchingTimeMs: log.matchingTimeMs,
    iterations: log.iterations,
  });
}
