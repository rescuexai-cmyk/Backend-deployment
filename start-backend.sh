#!/bin/bash
# Raahi Backend - Start All Services
# Run this script to start all microservices

cd "$(dirname "$0")"

echo "🛑 Stopping existing services..."
lsof -ti:3000,5001,5002,5003,5004,5005,5006,5007,5008 | xargs kill -9 2>/dev/null || true
sleep 2

echo "🚀 Starting all services..."

# Gateway (port 3000)
nohup node services/gateway/dist/index.js > /tmp/raahi-gateway.log 2>&1 &
sleep 2

# Microservices (ports 5001-5008)
nohup node services/auth-service/dist/index.js > /tmp/raahi-auth.log 2>&1 &
nohup node services/user-service/dist/index.js > /tmp/raahi-user.log 2>&1 &
nohup node services/driver-service/dist/index.js > /tmp/raahi-driver.log 2>&1 &
nohup node services/ride-service/dist/index.js > /tmp/raahi-ride.log 2>&1 &
nohup node services/pricing-service/dist/index.js > /tmp/raahi-pricing.log 2>&1 &
nohup node services/notification-service/dist/index.js > /tmp/raahi-notification.log 2>&1 &
nohup node services/realtime-service/dist/index.js > /tmp/raahi-realtime.log 2>&1 &
nohup node services/admin-service/dist/index.js > /tmp/raahi-admin.log 2>&1 &

sleep 4

echo ""
echo "✅ Services started! Checking health..."
curl -s http://localhost:3000/health && echo ""
echo ""
echo "📋 Running services:"
lsof -i :3000 -i :5001 -i :5002 -i :5003 -i :5004 -i :5005 -i :5006 -i :5007 -i :5008 2>/dev/null | grep LISTEN | awk '{print "  " $9 " - " $1}'
echo ""
echo "📝 Logs: /tmp/raahi-*.log"
echo "🛑 To stop: ./stop-backend.sh"
