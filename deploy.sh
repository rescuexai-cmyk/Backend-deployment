#!/bin/bash
# ============================================
# RAAHI BACKEND - DIGITALOCEAN DEPLOYMENT SCRIPT
# ============================================
# Run this on your DigitalOcean Droplet

set -e

echo "🚀 Starting Raahi Backend Deployment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Update system
echo -e "${YELLOW}📦 Updating system packages...${NC}"
apt-get update && apt-get upgrade -y

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

# Step 4: Install Git
echo -e "${YELLOW}📥 Installing Git...${NC}"
apt-get install -y git

# Step 5: Clone repository
echo -e "${YELLOW}📥 Cloning repository...${NC}"
cd /opt
if [ -d "raahi-backend" ]; then
    echo "Directory exists, pulling latest changes..."
    cd raahi-backend
    git pull origin main
else
    git clone https://github.com/rescuexai-cmyk/Backend-deployment.git raahi-backend
    cd raahi-backend
fi

# Step 6: Create .env file if not exists
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}📝 Creating .env file...${NC}"
    
    # Generate secure secrets
    JWT_SECRET=$(openssl rand -base64 32)
    REFRESH_SECRET=$(openssl rand -base64 32)
    INTERNAL_KEY=$(openssl rand -base64 32)
    POSTGRES_PASS=$(openssl rand -base64 24)
    ENCRYPTION_KEY=$(openssl rand -hex 16)
    
    cat > .env << EOF
# ============================================
# RAAHI BACKEND - PRODUCTION ENVIRONMENT
# Generated on $(date)
# ============================================

# Database
POSTGRES_PASSWORD=${POSTGRES_PASS}

# JWT Secrets
JWT_SECRET=${JWT_SECRET}
REFRESH_TOKEN_SECRET=${REFRESH_SECRET}

# Internal API Key
INTERNAL_API_KEY=${INTERNAL_KEY}

# Firebase Configuration
FIREBASE_PROJECT_ID=raahi-5f22e
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-fbsvc@raahi-5f22e.iam.gserviceaccount.com
# TODO: Add your Firebase private key here
FIREBASE_PRIVATE_KEY=""

# DigiLocker
DIGILOCKER_CLIENT_ID=
DIGILOCKER_CLIENT_SECRET=
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# Pricing
BASE_FARE=25
PER_KM_RATE=12
PER_MINUTE_RATE=2
EOF
    
    echo -e "${GREEN}✅ .env file created${NC}"
    echo -e "${RED}⚠️  IMPORTANT: Edit /opt/raahi-backend/.env to add your Firebase private key!${NC}"
fi

# Step 7: Create required directories
mkdir -p certbot/conf certbot/www

# Step 8: Build and start services
echo -e "${YELLOW}🏗️  Building Docker images...${NC}"
docker-compose -f docker-compose.prod.yml build

echo -e "${YELLOW}🚀 Starting services...${NC}"
docker-compose -f docker-compose.prod.yml up -d

# Step 9: Wait for services to be healthy
echo -e "${YELLOW}⏳ Waiting for services to start (this may take 2-3 minutes)...${NC}"
sleep 60

# Step 10: Check status
echo -e "${YELLOW}📊 Checking service status...${NC}"
docker-compose -f docker-compose.prod.yml ps

# Step 11: Test health endpoint
echo -e "${YELLOW}🏥 Testing health endpoint...${NC}"
sleep 10
if curl -s http://localhost/health | grep -q "ok\|healthy"; then
    echo -e "${GREEN}✅ Health check passed!${NC}"
else
    echo -e "${YELLOW}⚠️  Health check pending, services may still be starting...${NC}"
fi

# Get server IP
SERVER_IP=$(curl -s ifconfig.me)

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}🎉 DEPLOYMENT COMPLETE!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "Your API is available at:"
echo -e "  ${GREEN}http://${SERVER_IP}${NC}"
echo ""
echo -e "Endpoints:"
echo -e "  Health:    http://${SERVER_IP}/health"
echo -e "  API:       http://${SERVER_IP}/api/"
echo -e "  Socket.io: http://${SERVER_IP}/socket.io/"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo -e "1. Edit /opt/raahi-backend/.env to add Firebase private key"
echo -e "2. Run: docker-compose -f docker-compose.prod.yml restart"
echo -e "3. (Optional) Set up SSL with Let's Encrypt"
echo ""
echo -e "Useful commands:"
echo -e "  View logs:     docker-compose -f docker-compose.prod.yml logs -f"
echo -e "  Restart:       docker-compose -f docker-compose.prod.yml restart"
echo -e "  Stop:          docker-compose -f docker-compose.prod.yml down"
echo -e "  Status:        docker-compose -f docker-compose.prod.yml ps"
echo ""
