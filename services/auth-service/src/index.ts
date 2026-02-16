import express from 'express';
import cors from 'cors';
import { connectDatabase, errorHandler, notFound } from '@raahi/shared';
import authRoutes from './routes/auth';
import { createLogger } from '@raahi/shared';
import { initializeFirebase, getFirebaseStatus } from './firebaseAuth';

const logger = createLogger('auth-service');
const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => {
  const fbStatus = getFirebaseStatus();
  res.json({
    status: 'OK',
    service: 'auth-service',
    timestamp: new Date().toISOString(),
    firebase: {
      initialized: fbStatus.initialized,
      projectId: fbStatus.projectId,
    },
  });
});

app.use('/api/auth', authRoutes);

app.use(notFound);
app.use(errorHandler);

const start = async () => {
  await connectDatabase();

  // Initialize Firebase Admin SDK
  const fbApp = initializeFirebase();
  if (fbApp) {
    const status = getFirebaseStatus();
    logger.info(`Firebase initialized for project: ${status.projectId} (method: ${status.method})`);
  } else {
    logger.warn('Firebase not initialized - phone OTP auth via Firebase will be unavailable');
    logger.warn('Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_PROJECT_ID env vars to enable');
  }

  app.listen(PORT, () => logger.info(`Auth service running on port ${PORT}`));
};

start().catch((err) => {
  logger.error('Failed to start auth-service', { error: err });
  process.exit(1);
});
