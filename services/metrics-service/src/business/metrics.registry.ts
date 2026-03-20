/**
 * Metrics Registry - Central registry for all business metrics collectors
 * Designed for modularity: each domain (drivers, rides, revenue, etc.) registers here
 */

import { logger } from '@raahi/shared';

export interface MetricCollector {
  name: string;
  collect: () => Promise<string>;
}

class MetricsRegistry {
  private collectors: Map<string, MetricCollector> = new Map();

  register(collector: MetricCollector): void {
    this.collectors.set(collector.name, collector);
  }

  unregister(name: string): void {
    this.collectors.delete(name);
  }

  async collectAll(): Promise<string> {
    const results: string[] = [];
    const errors: string[] = [];

    for (const [name, collector] of this.collectors) {
      try {
        const metrics = await collector.collect();
        if (metrics && metrics.trim()) {
          results.push(`# DOMAIN: ${name}\n${metrics}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`# ERROR collecting ${name}: ${errorMsg}`);
        logger.error(`[METRICS] Failed to collect ${name}:`, error);
      }
    }

    const header = `# Raahi Business Metrics\n# Generated: ${new Date().toISOString()}\n# Collectors: ${this.collectors.size}\n\n`;
    
    return header + results.join('\n\n') + (errors.length > 0 ? '\n\n' + errors.join('\n') : '');
  }

  getCollectorNames(): string[] {
    return Array.from(this.collectors.keys());
  }
}

export const metricsRegistry = new MetricsRegistry();
