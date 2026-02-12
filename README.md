# Raahi Backend API - Microservices

A microservices-based backend for the Raahi cab booking application built with Node.js, Express, TypeScript, and PostgreSQL.

## Architecture

The backend is split into **9 independent services** with a shared package and an API Gateway.

| Service | Port | Responsibility |
|---|---|---|
| API Gateway | 5000 | Single entry point, proxies to all services |
| Auth Service | 5001 | OTP, Google, Truecaller login, JWT tokens |
| User Service | 5002 | User profile |
| Driver Service | 5003 | Driver profile, status, earnings, onboarding |
| Ride Service | 5004 | Ride CRUD, driver assignment, tracking |
| Pricing Service | 5005 | Fare calculation, surge, nearby drivers |
| Notification Service | 5006 | Notifications |
| Realtime Service | 5007 | Socket.io, live stats, driver heatmap |
| Admin Service | 5008 | Admin dashboard, driver/document verification |

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js (per service)
- **Database**: PostgreSQL with Prisma ORM (shared)
- **Realtime**: Socket.io (realtime-service)
- **Gateway**: http-proxy-middleware
- **Containerization**: Docker + Docker Compose

## Quick Start

```bash
# Install dependencies
npm install
npx prisma generate

# Start Postgres
docker-compose up -d postgres

# Run migrations
npx prisma migrate dev

# Start all services (each in its own terminal)
npm run dev:gateway
npm run dev:auth
npm run dev:user
npm run dev:driver
npm run dev:ride
npm run dev:pricing
npm run dev:notification
npm run dev:realtime
npm run dev:admin
```

Or with Docker Compose (all at once):

```bash
docker-compose up --build
```

API is available at `http://localhost:5000`.

## Project Structure

```
raahi-backend/
  packages/shared/         # Shared code: Prisma, logger, auth, error handling
  services/
    gateway/               # API Gateway
    auth-service/          # Authentication
    user-service/          # User profiles
    driver-service/        # Driver management
    ride-service/          # Ride management
    pricing-service/       # Pricing engine
    notification-service/  # Notifications
    realtime-service/      # WebSockets + real-time
    admin-service/         # Admin panel APIs
  prisma/                  # Database schema + migrations
  docker-compose.yml       # Full stack orchestration
```

## API Endpoints

All endpoints are accessed through the gateway at `http://localhost:5000`.

- `POST /api/auth/send-otp` - Send OTP
- `POST /api/auth/verify-otp` - Verify OTP & login
- `POST /api/auth/google` - Google OAuth
- `GET /api/auth/me` - Current user
- `POST /api/rides` - Create ride
- `GET /api/rides` - User's rides
- `GET /api/driver/profile` - Driver profile
- `PATCH /api/driver/status` - Go online/offline
- `POST /api/pricing/calculate` - Calculate fare
- `GET /api/realtime/stats` - Live statistics
- `GET /api/admin/drivers` - All drivers (admin)

See `MICROSERVICES.md` for full details.
