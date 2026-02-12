#!/bin/bash

echo "🚀 Setting up Raahi Backend with PostgreSQL + Prisma"
echo "=================================================="

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found. Please create it with your database URL."
    echo "   Copy test.env to .env and update DATABASE_URL"
    exit 1
fi

echo "📦 Installing dependencies..."
npm install

echo "🔧 Generating Prisma client..."
npx prisma generate

echo "🗄️ Running database migrations..."
npx prisma migrate dev --name init

echo "🌱 Seeding database..."
npx prisma db seed

echo "✅ Setup complete! Starting server..."
echo "🌐 Run 'npm run dev' to start the PostgreSQL backend"
echo ""
echo "📊 Your database now has:"
echo "   - Users, Drivers, Rides tables"
echo "   - Payment processing"
echo "   - Real-time notifications"
echo "   - Complete ride-hailing functionality"