import express from 'express';
import cors from 'cors';
import path from 'path';
import { connectDatabase, errorHandler, notFound, setupSwagger } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import rescueRoutes from './routes/rescue';

const logger = createLogger('rescue-service');
const app = express();
const PORT = process.env.PORT || 5009;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Setup Swagger documentation
setupSwagger(app, {
  title: 'Rescue Service API',
  version: '1.0.0',
  description: 'Raahi Rescue Service - Vehicle rescue, dual-driver dispatch, and progressive ride tracking',
  port: Number(PORT),
  basePath: '/api/rescue',
  apis: [path.join(__dirname, './routes/*.ts'), path.join(__dirname, './routes/*.js'), __filename],
});

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Health check endpoint
 *     responses:
 *       200:
 *         description: Service is healthy
 */
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'rescue-service', timestamp: new Date().toISOString() });
});

app.use('/api/rescue', rescueRoutes);

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(PORT, () => logger.info(`Rescue service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start rescue-service', { error: err });
  process.exit(1);
});
