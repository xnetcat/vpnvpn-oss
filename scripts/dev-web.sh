#!/bin/bash
set -e

# Colors for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() {
  echo -e "${BLUE}[dev:web]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[dev:web]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[dev:web]${NC} $1"
}

log_error() {
  echo -e "${RED}[dev:web]${NC} $1"
}

# Cleanup function
cleanup() {
  log "Shutting down services..."
  cd "$PROJECT_ROOT/local" && docker compose down
  log_success "Services stopped."
  exit 0
}

# Change to project root
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# Set trap for cleanup on exit
trap cleanup EXIT INT TERM

# Step 1: Regenerate Prisma client (ensures schema changes are picked up)
log "Regenerating Prisma client..."
cd packages/db && bun run build
cd "$PROJECT_ROOT"

# Step 2: Build all Docker images
log "Building Docker images (this ensures latest code is used)..."
cd local && docker compose build web-app control-plane metrics vpn-node
cd "$PROJECT_ROOT"

# Step 3: Start postgres first and wait for it
log "Starting postgres..."
cd local && docker compose up -d postgres
cd "$PROJECT_ROOT"

log "Waiting for postgres to be ready..."
until docker compose -f local/compose.yaml exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do
  sleep 1
done
log_success "Postgres is ready!"

# Step 4: Start services (control-plane will run migrations on boot)
log "Starting services (migrations will run automatically)..."
cd local && docker compose up -d control-plane metrics web-app vpn-node
cd "$PROJECT_ROOT"

# Step 5: Wait for API to be healthy
log "Waiting for API to be ready..."
MAX_RETRIES=60
RETRY_COUNT=0
until curl -sf http://localhost:3000/api/health >/dev/null 2>&1; do
  RETRY_COUNT=$((RETRY_COUNT + 1))
  if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
    log_error "API failed to start after ${MAX_RETRIES} attempts"
    log "Checking container logs..."
    cd local && docker compose logs web-app --tail=50
    exit 1
  fi
  sleep 2
done
log_success "API is ready!"

# Step 6: Start dev processes (no desktop)
log "Starting web development environment (no desktop)..."
log_warn "File watching is enabled - services will rebuild automatically on code changes"
log ""
log "  📁 apps/web/{app,components,lib}  → rebuilds web-app container"
log "  📁 services/control-plane         → rebuilds control-plane container"
log "  📁 services/metrics               → rebuilds metrics container"
log "  📁 apps/vpn-server                → rebuilds vpn-node container"
log "  📁 packages/*                     → rebuilds dependent containers"
log ""

exec npx concurrently \
  --kill-others \
  --names "watch,stripe,studio" \
  --prefix-colors "blue,cyan,yellow" \
  "cd $PROJECT_ROOT/local && docker compose watch" \
  "cd $PROJECT_ROOT && bun run dev:stripe" \
  "cd $PROJECT_ROOT && bun run dev:studio"
