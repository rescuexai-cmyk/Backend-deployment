# Railway Deployment Guide - Raahi Backend Microservices

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Railway Project                         │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ Gateway  │  │   Auth   │  │   User   │  │  Driver  │    │
│  │  :3000   │  │  :5001   │  │  :5002   │  │  :5003   │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │   Ride   │  │ Pricing  │  │  Notif   │  │ Realtime │    │
│  │  :5004   │  │  :5005   │  │  :5006   │  │  :5007   │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│  ┌──────────┐  ┌──────────────────────────────────────┐    │
│  │  Admin   │  │           PostgreSQL                 │    │
│  │  :5008   │  │      (Railway Managed DB)            │    │
│  └──────────┘  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Step 1: Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Connect to `rescuexai-cmyk/Backend-deployment`

## Step 2: Add PostgreSQL Database

1. In your Railway project, click **"+ New"**
2. Select **"Database"** → **"PostgreSQL"**
3. Railway will create a managed PostgreSQL instance
4. Copy the `DATABASE_URL` from the PostgreSQL service variables

## Step 3: Deploy Each Microservice

For each service, create a new service in Railway:

### Service 1: Gateway (Main Entry Point)
```
Name: gateway
Root Directory: /
Start Command: node services/gateway/dist/index.js
Port: 3000
```

### Service 2: Auth Service
```
Name: auth-service
Root Directory: /
Start Command: node services/auth-service/dist/index.js
Port: 5001
```

### Service 3: User Service
```
Name: user-service
Root Directory: /
Start Command: node services/user-service/dist/index.js
Port: 5002
```

### Service 4: Driver Service
```
Name: driver-service
Root Directory: /
Start Command: node services/driver-service/dist/index.js
Port: 5003
```

### Service 5: Ride Service
```
Name: ride-service
Root Directory: /
Start Command: node services/ride-service/dist/index.js
Port: 5004
```

### Service 6: Pricing Service
```
Name: pricing-service
Root Directory: /
Start Command: node services/pricing-service/dist/index.js
Port: 5005
```

### Service 7: Notification Service
```
Name: notification-service
Root Directory: /
Start Command: node services/notification-service/dist/index.js
Port: 5006
```

### Service 8: Realtime Service (Socket.io)
```
Name: realtime-service
Root Directory: /
Start Command: node services/realtime-service/dist/index.js
Port: 5007
```

### Service 9: Admin Service
```
Name: admin-service
Root Directory: /
Start Command: node services/admin-service/dist/index.js
Port: 5008
```

## Step 4: Configure Environment Variables

### Shared Variables (Add to ALL services)
```env
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
REFRESH_TOKEN_SECRET=your-refresh-token-secret-min-32-chars
INTERNAL_API_KEY=your-internal-api-key
```

### Gateway Service Variables
```env
PORT=3000
AUTH_SERVICE_URL=${{auth-service.RAILWAY_PRIVATE_DOMAIN}}:5001
USER_SERVICE_URL=${{user-service.RAILWAY_PRIVATE_DOMAIN}}:5002
DRIVER_SERVICE_URL=${{driver-service.RAILWAY_PRIVATE_DOMAIN}}:5003
RIDE_SERVICE_URL=${{ride-service.RAILWAY_PRIVATE_DOMAIN}}:5004
PRICING_SERVICE_URL=${{pricing-service.RAILWAY_PRIVATE_DOMAIN}}:5005
NOTIFICATION_SERVICE_URL=${{notification-service.RAILWAY_PRIVATE_DOMAIN}}:5006
REALTIME_SERVICE_URL=${{realtime-service.RAILWAY_PRIVATE_DOMAIN}}:5007
ADMIN_SERVICE_URL=${{admin-service.RAILWAY_PRIVATE_DOMAIN}}:5008
```

### Auth Service Variables
```env
PORT=5001
FIREBASE_PROJECT_ID=raahi-5f22e
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@raahi-5f22e.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_CLIENT_ID=your-google-client-id
TRUECALLER_CLIENT_ID=your-truecaller-client-id
```

### Ride Service Variables
```env
PORT=5004
PRICING_SERVICE_URL=${{pricing-service.RAILWAY_PRIVATE_DOMAIN}}:5005
REALTIME_SERVICE_URL=${{realtime-service.RAILWAY_PRIVATE_DOMAIN}}:5007
NOTIFICATION_SERVICE_URL=${{notification-service.RAILWAY_PRIVATE_DOMAIN}}:5006
```

### Notification Service Variables
```env
PORT=5006
FIREBASE_PROJECT_ID=raahi-5f22e
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@raahi-5f22e.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

### Realtime Service Variables
```env
PORT=5007
NOTIFICATION_SERVICE_URL=${{notification-service.RAILWAY_PRIVATE_DOMAIN}}:5006
```

### Driver Service Variables
```env
PORT=5003
DIGILOCKER_CLIENT_ID=your-digilocker-client-id
DIGILOCKER_CLIENT_SECRET=your-digilocker-client-secret
DIGILOCKER_REDIRECT_URI=https://your-gateway-domain.railway.app/api/driver/digilocker/callback
ENCRYPTION_KEY=your-32-character-encryption-key
```

### Pricing Service Variables
```env
PORT=5005
BASE_FARE=25
PER_KM_RATE=12
PER_MINUTE_RATE=2
H3_RESOLUTION=9
H3_MAX_K_RING=3
```

## Step 5: Run Database Migrations

After all services are deployed, run migrations:

```bash
# In Railway CLI or via the service shell
npx prisma migrate deploy
```

Or add this as a one-time job in Railway.

## Step 6: Configure Custom Domains

1. Go to Gateway service → **Settings** → **Networking**
2. Click **"Generate Domain"** or add custom domain
3. Your API will be available at: `https://your-app.railway.app`

## Step 7: Update Flutter App

Update your Flutter app's base URLs:

```dart
// lib/config/api_config.dart
class ApiConfig {
  static const String baseUrl = 'https://gateway-production-xxxx.railway.app';
  static const String socketUrl = 'https://realtime-production-xxxx.railway.app';
}
```

## Quick Deploy Script (Railway CLI)

Install Railway CLI:
```bash
npm install -g @railway/cli
railway login
```

Deploy:
```bash
cd raahi-backend
railway up
```

## Cost Estimation (Railway)

| Service | RAM | CPU | Est. Cost/Month |
|---------|-----|-----|-----------------|
| PostgreSQL | 1GB | Shared | ~$5 |
| Gateway | 512MB | Shared | ~$5 |
| Auth | 512MB | Shared | ~$5 |
| User | 256MB | Shared | ~$3 |
| Driver | 256MB | Shared | ~$3 |
| Ride | 256MB | Shared | ~$3 |
| Pricing | 256MB | Shared | ~$3 |
| Notification | 256MB | Shared | ~$3 |
| Realtime | 512MB | Shared | ~$5 |
| Admin | 256MB | Shared | ~$3 |
| **Total** | | | **~$38/month** |

*Railway offers $5 free credit for hobby projects*

## Troubleshooting

### Services can't connect to each other
- Use `RAILWAY_PRIVATE_DOMAIN` for internal communication
- Format: `http://service-name.railway.internal:PORT`

### Database connection issues
- Ensure `DATABASE_URL` is set correctly
- Check PostgreSQL is running
- Run `npx prisma db push` to sync schema

### Socket.io not working
- Ensure realtime-service has public domain
- WebSocket connections need direct access (not through gateway)

### Build failures
- Check Node.js version (use 18+)
- Ensure all dependencies are in package.json
- Check build logs for TypeScript errors

## Health Check Endpoints

All services expose `/health`:
- Gateway: `https://gateway.railway.app/health`
- Auth: Internal only
- All others: Internal only

## Monitoring

Railway provides built-in:
- Logs (real-time)
- Metrics (CPU, Memory, Network)
- Deployment history
- Rollback capability
