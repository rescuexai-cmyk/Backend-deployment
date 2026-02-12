# Raahi Backend - Microservices Architecture

The backend runs as **independent microservices** with an **API Gateway** as the single entry point.

## Services

| Service              | Port | Responsibility                           |
|----------------------|------|------------------------------------------|
| **API Gateway**      | 3000 | Single entry point, routes to services   |
| **Auth Service**     | 5001 | Login, OTP, Google/Truecaller, tokens    |
| **User Service**     | 5002 | User profile                             |
| **Driver Service**   | 5003 | Driver profile, status, onboarding       |
| **Ride Service**     | 5004 | Ride CRUD, assign driver, status         |
| **Pricing Service**  | 5005 | Fare calculation, surge, nearby drivers  |
| **Notification Service** | 5006 | Notifications                        |
| **Realtime Service** | 5007 | Socket.io + real-time stats              |
| **Admin Service**    | 5008 | Admin drivers, documents, stats          |

## Run locally (development)

1. **Install dependencies and generate Prisma:**
   ```bash
   npm install
   npx prisma generate
   ```

2. **Start Postgres:**
   ```bash
   docker-compose up -d postgres
   ```

3. **Start each service in a separate terminal:**
   ```bash
   npm run dev:gateway      # Terminal 1
   npm run dev:auth         # Terminal 2
   npm run dev:user         # Terminal 3
   npm run dev:driver       # Terminal 4
   npm run dev:ride         # Terminal 5
   npm run dev:pricing      # Terminal 6
   npm run dev:notification # Terminal 7
   npm run dev:realtime     # Terminal 8
   npm run dev:admin        # Terminal 9
   ```

4. **Call the API** via the gateway at `http://localhost:3000`
   - Health: `GET /health`
   - Auth: `POST /api/auth/send-otp`
   - Rides: `POST /api/rides`
   - Socket.io connects through the gateway (proxied to realtime-service)

## Run with Docker Compose

```bash
docker-compose up --build
```

All services start automatically. Gateway at `http://localhost:3000`.

## Environment variables

- **All services:** `DATABASE_URL`, `JWT_SECRET`
- **Auth service:** `REFRESH_TOKEN_SECRET`, optional `TWILIO_*`, `GOOGLE_CLIENT_ID`
- **Ride service:** `PRICING_SERVICE_URL`, `REALTIME_SERVICE_URL` (for inter-service HTTP)
- **Gateway:** `AUTH_SERVICE_URL`, `RIDE_SERVICE_URL`, etc. (defaults to localhost ports)

## Inter-service communication

- **Ride -> Pricing:** HTTP `POST /api/pricing/calculate`, `GET /api/pricing/nearby-drivers`
- **Ride -> Realtime:** HTTP `POST /internal/broadcast-ride-request`, `POST /internal/ride-status-update`, etc.
- Clients only talk to the **gateway**; the gateway forwards to the correct service.

## Project structure

```
raahi-backend/
  packages/
    shared/           # Shared: Prisma, logger, auth middleware, error handler
  services/
    gateway/           # API Gateway (port 3000)
    auth-service/      # Auth (port 5001)
    user-service/      # User (port 5002)
    driver-service/    # Driver (port 5003)
    ride-service/      # Ride (port 5004)
    pricing-service/   # Pricing (port 5005)
    notification-service/ # Notifications (port 5006)
    realtime-service/  # Realtime + Socket.io (port 5007)
    admin-service/     # Admin (port 5008)
  prisma/              # Schema + migrations (shared DB)
  docker-compose.yml   # All services + Postgres
```
