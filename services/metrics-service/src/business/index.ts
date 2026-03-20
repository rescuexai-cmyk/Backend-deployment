/**
 * Business Metrics Module - Main Exporter
 * Aggregates all domain collectors and exposes unified metrics endpoint
 */

import { logger } from '@raahi/shared';
import { metricsRegistry } from './metrics.registry';
import { collectDriverMetrics } from './drivers.metrics';
import { collectRideMetrics } from './rides.metrics';
import { collectUserMetrics } from './users.metrics';
import { metricsCache } from './metrics.cache';

export function registerAllCollectors(): void {
  metricsRegistry.register({
    name: 'drivers',
    collect: collectDriverMetrics,
  });
  metricsRegistry.register({
    name: 'rides',
    collect: collectRideMetrics,
  });
  metricsRegistry.register({
    name: 'users',
    collect: collectUserMetrics,
  });

  logger.info('[METRICS] Registered collectors:', metricsRegistry.getCollectorNames().join(', '));
}

export async function collectAllBusinessMetrics(): Promise<string> {
  return metricsRegistry.collectAll();
}

export function getMetricsCacheStats() {
  return metricsCache.getStats();
}

export function clearMetricsCache(): void {
  metricsCache.clear();
}

export { metricsRegistry } from './metrics.registry';
export { metricsCache, withCache } from './metrics.cache';
export { collectDriverMetrics } from './drivers.metrics';
export { collectRideMetrics } from './rides.metrics';
export { collectUserMetrics } from './users.metrics';
