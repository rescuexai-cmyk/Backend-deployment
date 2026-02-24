import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { createLogger } from '@raahi/shared';

const logger = createLogger('gateway');
const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_SERVICE = process.env.AUTH_SERVICE_URL || 'http://localhost:5001';
const USER_SERVICE = process.env.USER_SERVICE_URL || 'http://localhost:5002';
const DRIVER_SERVICE = process.env.DRIVER_SERVICE_URL || 'http://localhost:5003';
const RIDE_SERVICE = process.env.RIDE_SERVICE_URL || 'http://localhost:5004';
const PRICING_SERVICE = process.env.PRICING_SERVICE_URL || 'http://localhost:5005';
const NOTIFICATION_SERVICE = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5006';
const REALTIME_SERVICE = process.env.REALTIME_SERVICE_URL || 'http://localhost:5007';
const ADMIN_SERVICE = process.env.ADMIN_SERVICE_URL || 'http://localhost:5008';

app.use(helmet());
app.use(compression());
app.use(morgan('combined', { stream: { write: (m: string) => logger.info(m.trim()) } }));
app.use(cors({ origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*', credentials: true }));

// Health check (no proxy, no body parsing needed)
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// SECURITY: Block all /internal/* routes from being exposed through the gateway
// These routes are for internal service-to-service communication only
app.use('/internal', (req, res) => {
  logger.warn(`Blocked attempt to access internal route: ${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.status(403).json({
    success: false,
    message: 'Access denied - internal routes are not accessible via gateway',
  });
});

// Also block any path containing /internal/ in case services expose them under their API paths
app.use('*/internal/*', (req, res) => {
  logger.warn(`Blocked attempt to access internal route: ${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  res.status(403).json({
    success: false,
    message: 'Access denied - internal routes are not accessible via gateway',
  });
});

// Body parsing - SKIP for multipart/form-data (file uploads)
// Multipart requests should pass through raw to the backend
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    // Skip body parsing for file uploads
    return next();
  }
  express.json({ limit: '10mb' })(req, res, next);
});

const proxyOptions = {
  changeOrigin: true,
  timeout: 120000, // 2 minute timeout for slow connections
  proxyTimeout: 120000,
  onProxyReq: (proxyReq: any, req: express.Request) => {
    const contentType = req.headers['content-type'] || '';
    // Only fix body for JSON requests, NOT multipart
    if (!contentType.includes('multipart/form-data')) {
      fixRequestBody(proxyReq, req);
    }
    // Set auth header if present
    if (req.headers.authorization && !proxyReq.headersSent) {
      try {
        proxyReq.setHeader('Authorization', req.headers.authorization);
      } catch (e) {
        // Headers already sent (e.g., WebSocket upgrade), ignore
      }
    }
  },
  onError: (err: Error, req: express.Request, res: express.Response) => {
    logger.error('Proxy error', { error: err.message, path: req.path, method: req.method });
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: 'Service temporarily unavailable' });
    }
  },
};

// Special proxy options for file uploads - no body manipulation
const uploadProxyOptions = {
  target: DRIVER_SERVICE,
  changeOrigin: true,
  timeout: 120000,
  proxyTimeout: 120000,
  onProxyReq: (proxyReq: any, req: express.Request) => {
    // Just forward authorization, don't touch the body
    if (req.headers.authorization && !proxyReq.headersSent) {
      try {
        proxyReq.setHeader('Authorization', req.headers.authorization);
      } catch (e) {
        // Ignore
      }
    }
  },
  onError: (err: Error, req: express.Request, res: express.Response) => {
    logger.error('Upload proxy error', { error: err.message, path: req.path });
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: 'Upload service temporarily unavailable' });
    }
  },
};

// WebSocket proxy options (no body handling needed)
const wsProxyOptions = {
  target: REALTIME_SERVICE,
  changeOrigin: true,
  ws: true,
  onError: (err: Error, req: express.Request, res: express.Response) => {
    logger.error('WebSocket proxy error', { error: err.message, path: req.path });
  },
};

// SSE proxy options - disable response buffering for streaming
const sseProxyOptions = {
  target: REALTIME_SERVICE,
  changeOrigin: true,
  // Critical for SSE: disable response buffering so events stream immediately
  onProxyRes: (proxyRes: any) => {
    // Ensure no buffering for SSE connections
    proxyRes.headers['x-accel-buffering'] = 'no';
    proxyRes.headers['cache-control'] = 'no-cache, no-transform';
  },
  onProxyReq: (proxyReq: any, req: express.Request) => {
    fixRequestBody(proxyReq, req);
    if (req.headers.authorization && !proxyReq.headersSent) {
      try {
        proxyReq.setHeader('Authorization', req.headers.authorization);
      } catch (e) {
        // Headers already sent, ignore
      }
    }
  },
  onError: (err: Error, req: express.Request, res: express.Response) => {
    logger.error('SSE proxy error', { error: err.message, path: req.path });
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: 'Real-time service temporarily unavailable' });
    }
  },
};

// MQTT-over-WebSocket proxy options
const MQTT_WS_SERVICE = process.env.MQTT_WS_SERVICE_URL || 'http://localhost:8883';
const mqttWsProxyOptions = {
  target: MQTT_WS_SERVICE,
  changeOrigin: true,
  ws: true,
  onError: (err: Error, req: express.Request, res: express.Response) => {
    logger.error('MQTT WebSocket proxy error', { error: err.message, path: req.path });
  },
};

app.use('/api/auth', createProxyMiddleware({ target: AUTH_SERVICE, ...proxyOptions }));
app.use('/api/user', createProxyMiddleware({ target: USER_SERVICE, ...proxyOptions }));
// File upload endpoint - must come before general /api/driver route
app.use('/api/driver/onboarding/document/upload', createProxyMiddleware(uploadProxyOptions));
app.use('/api/driver', createProxyMiddleware({ target: DRIVER_SERVICE, ...proxyOptions }));
app.use('/api/rides', createProxyMiddleware({ target: RIDE_SERVICE, ...proxyOptions }));
app.use('/api/pricing', createProxyMiddleware({ target: PRICING_SERVICE, ...proxyOptions }));
app.use('/api/notifications', createProxyMiddleware({ target: NOTIFICATION_SERVICE, ...proxyOptions }));
// SSE endpoints need special proxy config (no buffering)
app.use('/api/realtime/sse', createProxyMiddleware(sseProxyOptions));
// Other realtime endpoints use standard proxy
app.use('/api/realtime', createProxyMiddleware({ target: REALTIME_SERVICE, ...proxyOptions }));
app.use('/api/admin', createProxyMiddleware({ target: ADMIN_SERVICE, ...proxyOptions }));
app.use('/uploads', createProxyMiddleware({ target: DRIVER_SERVICE, ...proxyOptions }));
// WebSocket proxy for Socket.io (legacy, backward compatibility)
app.use('/socket.io', createProxyMiddleware(wsProxyOptions));
// MQTT over WebSocket proxy (for lightweight real-time messaging)
app.use('/mqtt', createProxyMiddleware(mqttWsProxyOptions));

app.listen(PORT, () => {
  logger.info(`════════════════════════════════════════════════════════════════`);
  logger.info(`  Raahi API Gateway - Hybrid Transport Proxy`);
  logger.info(`════════════════════════════════════════════════════════════════`);
  logger.info(`  HTTP API    : port ${PORT}`);
  logger.info(`  SSE Proxy   : /api/realtime/sse/* → ${REALTIME_SERVICE}`);
  logger.info(`  Socket.io   : /socket.io → ${REALTIME_SERVICE} (legacy)`);
  logger.info(`  MQTT WS     : /mqtt → ${MQTT_WS_SERVICE}`);
  logger.info(`════════════════════════════════════════════════════════════════`);
});
