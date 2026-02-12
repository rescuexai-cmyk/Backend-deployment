#!/bin/bash
# Raahi Backend - Stop All Services

echo "🛑 Stopping all Raahi services..."
lsof -ti:3000,5001,5002,5003,5004,5005,5006,5007,5008 | xargs kill -9 2>/dev/null || true
echo "✅ All services stopped"
