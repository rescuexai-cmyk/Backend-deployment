#!/bin/bash
# ============================================
# RAAHI BACKEND - SEQUENTIAL BUILD DEPLOYMENT
# Optimized for low-memory VPS (1-2GB RAM)
# Keeps full microservices architecture
# ============================================

set -e

echo "🚀 Starting Raahi Backend Deployment (Sequential Build)..."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Step 1: Update system (non-interactive)
echo -e "${YELLOW}📦 Updating system packages...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get upgrade -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold"

# Step 2: Install Docker
echo -e "${YELLOW}🐳 Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    systemctl enable docker
    systemctl start docker
    echo -e "${GREEN}✅ Docker installed${NC}"
else
    echo -e "${GREEN}✅ Docker already installed${NC}"
fi

# Step 3: Install Docker Compose
echo -e "${YELLOW}🐳 Installing Docker Compose...${NC}"
if ! command -v docker-compose &> /dev/null; then
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo -e "${GREEN}✅ Docker Compose installed${NC}"
else
    echo -e "${GREEN}✅ Docker Compose already installed${NC}"
fi

# Step 4: Create swap if not exists (critical for low memory)
echo -e "${YELLOW}💾 Setting up swap space...${NC}"
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo -e "${GREEN}✅ 2GB swap created${NC}"
else
    swapon /swapfile 2>/dev/null || true
    echo -e "${GREEN}✅ Swap already exists${NC}"
fi
free -h

# Step 5: Install Git
apt-get install -y git

# Step 6: Clone repository
echo -e "${YELLOW}📥 Cloning repository...${NC}"
cd /opt
if [ -d "raahi-backend" ]; then
    cd raahi-backend
    git pull origin main
else
    git clone https://github.com/rescuexai-cmyk/Backend-deployment.git raahi-backend
    cd raahi-backend
fi

# Step 7: Create .env file if not exists
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}📝 Creating .env file...${NC}"
    JWT_SECRET=$(openssl rand -base64 32)
    REFRESH_SECRET=$(openssl rand -base64 32)
    INTERNAL_KEY=$(openssl rand -base64 32)
    POSTGRES_PASS=$(openssl rand -base64 24)
    ENCRYPTION_KEY=$(openssl rand -hex 16)
    
    cat > .env << EOF
# RAAHI BACKEND - PRODUCTION
# Generated on $(date)

POSTGRES_PASSWORD=${POSTGRES_PASS}
JWT_SECRET=${JWT_SECRET}
REFRESH_TOKEN_SECRET=${REFRESH_SECRET}
INTERNAL_API_KEY=${INTERNAL_KEY}
FIREBASE_PROJECT_ID=raahi-5f22e
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@raahi-5f22e.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=""
DIGILOCKER_CLIENT_ID=
DIGILOCKER_CLIENT_SECRET=
ENCRYPTION_KEY=${ENCRYPTION_KEY}
BASE_FARE=25
PER_KM_RATE=12
PER_MINUTE_RATE=2
EOF
    echo -e "${GREEN}✅ .env file created${NC}"
fi

# Step 8: Create directories
mkdir -p certbot/conf certbot/www

# ============================================
# SEQUENTIAL BUILD - One service at a time
# This prevents memory exhaustion
# ============================================

echo -e "${YELLOW}🏗️  Building services SEQUENTIALLY (memory-optimized)...${NC}"

# List of services to build in order
SERVICES=(
    "postgres"
    "pricing-service"
    "notification-service"
    "realtime-service"
    "auth-service"
    "user-service"
    "driver-service"
    "ride-service"
    "admin-service"
    "gateway"
    "nginx"
)

# Build and start each service one by one
for service in "${SERVICES[@]}"; do
    echo ""
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${YELLOW}🔨 Building: ${service}${NC}"
    echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    
    # Build with memory limit
    docker-compose -f docker-compose.prod.yml build --memory=512m ${service} 2>/dev/null || \
    docker-compose -f docker-compose.prod.yml build ${service}
    
    echo -e "${GREEN}✅ ${service} built successfully${NC}"
    
    # Clear build cache to free memory
    docker builder prune -f 2>/dev/null || true
    
    # Small pause to let system stabilize
    sleep 2
done

echo ""
echo -e "${GREEN}✅ All services built!${NC}"

# Step 9: Start all services
echo -e "${YELLOW}🚀 Starting all services...${NC}"
docker-compose -f docker-compose.prod.yml up -d

# Step 10: Wait and check
echo -e "${YELLOW}⏳ Waiting for services to start (90 seconds)...${NC}"
sleep 90

echo -e "${YELLOW}📊 Service status:${NC}"
docker-compose -f docker-compose.prod.yml ps

# Step 11: Health check
echo -e "${YELLOW}🏥 Testing health endpoint...${NC}"
sleep 10
if curl -s http://localhost/health | grep -q "ok\|healthy"; then
    echo -e "${GREEN}✅ Health check passed!${NC}"
else
    echo -e "${YELLOW}⚠️  Services may still be starting...${NC}"
fi

SERVER_IP=$(curl -s ifconfig.me)

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}🎉 DEPLOYMENT COMPLETE!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "API: ${GREEN}http://${SERVER_IP}${NC}"
echo -e "Health: http://${SERVER_IP}/health"
echo -e "Socket.io: http://${SERVER_IP}/socket.io/"
echo ""
echo -e "${YELLOW}Add Firebase key:${NC}"
echo -e "  nano /opt/raahi-backend/.env"
echo -e "  docker-compose -f docker-compose.prod.yml restart"
echo ""
