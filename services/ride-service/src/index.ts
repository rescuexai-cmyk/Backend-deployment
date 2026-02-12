import express from 'express';
import cors from 'cors';
import { connectDatabase, errorHandler, notFound } from '@raahi/shared';
import { createLogger } from '@raahi/shared';
import rideRoutes from './routes/ride';

const logger = createLogger('ride-service');
const app = express();
const PORT = process.env.PORT || 5004;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'ride-service', timestamp: new Date().toISOString() });
});

app.use('/api/rides', rideRoutes);

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(PORT, () => logger.info(`Ride service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start ride-service', { error: err });
  process.exit(1);
});
