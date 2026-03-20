/**
 * Raahi Metrics Service
 * Exposes business KPIs in Prometheus format
 * Internal service - not exposed publicly
 */

import express, { Request, Response } from 'express';
import { logger, connectDatabase } from '@raahi/shared';
import { 
  registerAllCollectors, 
  collectAllBusinessMetrics, 
  getMetricsCacheStats,
  clearMetricsCache 
} from './business';

const app = express();
const PORT = process.env.PORT || 5010;

connectDatabase().then(() => {
  logger.info('[METRICS] Database connected');
}).catch((err) => {
  logger.error('[METRICS] Database connection failed:', err);
});

registerAllCollectors();

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'OK',
    service: 'metrics-service',
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics/business', async (_req: Request, res: Response) => {
  try {
    const metrics = await collectAllBusinessMetrics();
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(metrics);
  } catch (error) {
    logger.error('[METRICS] Error collecting business metrics:', error);
    res.status(500).set('Content-Type', 'text/plain').send('# ERROR: Failed to collect metrics\n');
  }
});

app.get('/metrics/business/cache', (_req: Request, res: Response) => {
  res.json(getMetricsCacheStats());
});

app.post('/metrics/business/cache/clear', (_req: Request, res: Response) => {
  clearMetricsCache();
  res.json({ success: true, message: 'Cache cleared' });
});

app.get('/metrics/business/health', async (_req: Request, res: Response) => {
  try {
    const startTime = Date.now();
    const metrics = await collectAllBusinessMetrics();
    const duration = Date.now() - startTime;
    
    res.json({
      status: 'OK',
      collectionTimeMs: duration,
      metricsLength: metrics.length,
      cacheStats: getMetricsCacheStats(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'ERROR',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.listen(PORT, () => {
  logger.info(`[METRICS] Business metrics service running on port ${PORT}`);
  logger.info(`[METRICS] Endpoints: GET /metrics/business, GET /metrics/business/health, GET /metrics/business/cache`);
});
