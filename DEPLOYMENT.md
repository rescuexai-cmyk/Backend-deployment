# Raahi Backend – Deployment Guide

This document covers production readiness, scalability, and launch checklist for the Raahi microservices backend.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+ (or use `docker-compose` Postgres)
- For production: set all required env vars (no defaults for secrets)

## Quick Start (Development)

```bash
# 1. Install and generate Prisma
npm install && npx prisma generate

# 2. Start Postgres (if using Docker)
docker-compose up -d postgres

# 3. Apply schema (first time or after schema changes)
npx prisma db push   # dev; use migrations in production

# 4. Start all services (gateway on 3000, others 5001–5008)
npm run dev:gateway
# In separate terminals: dev:auth, dev:user, dev:driver, dev:ride,
# dev:pricing, dev:notification, dev:realtime, dev:admin
```

API base: `http://localhost:3000`  
Health: `GET http://localhost:3000/health`

## Docker Compose (Single Host)

```bash
cp env.example .env
# Edit .env: set JWT_SECRET, REFRESH_TOKEN_SECRET, DATABASE_URL (or use Compose Postgres)

docker-compose up -d postgres   # optional if you have external Postgres
npx prisma db push              # or migrate deploy
docker-compose up --build -d
```

- Gateway is exposed on **port 3000** (override with `GATEWAY_PORT`).
- All services use env vars from `.env`; same secrets must be set across auth/user/driver/ride/notification/admin.

## Production Checklist

### Security

- [ ] Set strong `JWT_SECRET` and `REFRESH_TOKEN_SECRET` (min 32 chars).
- [ ] Use a dedicated Postgres user with limited privileges; never commit real `DATABASE_URL`.
- [ ] Set `NODE_ENV=production` for all services.
- [ ] Set `FRONTEND_URL` to your frontend origin (e.g. `https://app.raahi.com`) for CORS.
- [ ] Serve over HTTPS; put gateway behind a reverse proxy (e.g. Nginx, Cloud Load Balancer).
- [ ] Do not expose internal service ports (5001–5008) to the internet; only gateway (3000) should be public.

### Database

- [ ] Prefer **migrations** in production: `npx prisma migrate deploy` (not `db push`).
- [ ] Use connection pooling (e.g. PgBouncer) if you scale service instances.
- [ ] Back up Postgres regularly; test restore.

### Scalability & Flexibility

- **Stateless services:** All services are stateless; scale by running multiple instances behind a load balancer.
- **Gateway:** Run multiple gateway instances; load balance on port 3000.
- **Realtime (Socket.io):** For multiple realtime-service instances, use a sticky session or Redis adapter (Socket.io Redis adapter) so events are broadcast across instances.
- **Database:** Use read replicas for read-heavy services (user, ride history) if needed later.
- **Secrets:** Use a secret manager (e.g. AWS Secrets Manager, GCP Secret Manager) and inject into containers; never bake secrets into images.

### Observability

- [ ] Centralise logs (e.g. stdout → CloudWatch, Datadog, or file rotation).
- [ ] Use `/health` for liveness; add readiness checks (e.g. DB connected) if needed.
- [ ] Optionally add metrics (request latency, error rate) and alerting.

### Environment Variables Summary

| Variable | Where | Required |
|----------|--------|----------|
| `DATABASE_URL` | All services (except gateway) | Yes |
| `JWT_SECRET` | Auth, User, Driver, Ride, Notification, Admin | Yes |
| `REFRESH_TOKEN_SECRET` | Auth | Yes |
| `PORT` | Each service (defaults: gateway 3000, others 5001–5008) | No (defaults set) |
| `FRONTEND_URL` | Gateway (CORS) | Yes in production |
| `AUTH_SERVICE_URL` etc. | Gateway | Yes when services are on other hosts |
| `PRICING_SERVICE_URL`, `REALTIME_SERVICE_URL` | Ride service | Yes for ride flow |
| `TWILIO_*`, `GOOGLE_MAPS_API_KEY`, etc. | Per feature | As needed |

## Frontend Integration

- **API base URL:** `https://your-gateway-domain/api` (or `http://10.0.2.2:3000/api` for Android emulator to host).
- **WebSocket (Socket.io):** Same host and port as API base; path `/socket.io` is handled by the gateway proxy to realtime-service.
- Ensure `FRONTEND_URL` matches the origin of the Flutter web/app to avoid CORS issues.

## Troubleshooting

- **502 from gateway:** Check that the target microservice is running and reachable at the URL configured in the gateway env.
- **DB connection errors:** Verify `DATABASE_URL`, network, and that migrations have been applied.
- **CORS errors:** Set `FRONTEND_URL` and ensure gateway is using it when `NODE_ENV=production`.
