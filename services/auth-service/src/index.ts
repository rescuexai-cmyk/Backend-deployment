import express from 'express';
import cors from 'cors';
import { connectDatabase, errorHandler, notFound } from '@raahi/shared';
import authRoutes from './routes/auth';
import { createLogger } from '@raahi/shared';

const logger = createLogger('auth-service');
const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'auth-service', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();
  app.listen(PORT, () => logger.info(`Auth service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start auth-service', { error: err });
  process.exit(1);
});
