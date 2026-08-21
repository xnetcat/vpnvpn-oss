#!/bin/bash
set -e

# Colors for output
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() {
  echo -e "${BLUE}[dev]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[dev]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[dev]${NC} $1"
}

log_error() {
  echo -e "${RED}[dev]${NC} $1"
}

# Change to project root
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# Sudo keepalive PID (will be set later)
SUDO_PID=""

# Cleanup function
cleanup() {
  log "Shutting down services..."
  [ -n "$SUDO_PID" ] && kill "$SUDO_PID" 2>/dev/null || true
  cd "$PROJECT_ROOT/local" && docker compose down
  log_success "Services stopped."
  exit 0
}

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

# Step 5: Wait for all services to be healthy
log "Waiting for all services to be ready..."

wait_for_service() {
  local name=$1
  local url=$2
  local max_retries=${3:-60}
  local retry_count=0
  
  log "Waiting for $name..."
  until curl -sf "$url" >/dev/null 2>&1; do
    retry_count=$((retry_count + 1))
    if [ $retry_count -ge $max_retries ]; then
      log_error "$name failed to start after ${max_retries} attempts"
      log "Checking container logs..."
      cd "$PROJECT_ROOT/local" && docker compose logs "$name" --tail=50
      return 1
    fi
    sleep 2
  done
  log_success "$name is ready!"
  return 0
}

wait_for_container() {
  local name=$1
  local max_retries=${2:-60}
  local retry_count=0
  
  log "Waiting for $name container to be running..."
  until cd "$PROJECT_ROOT/local" && docker compose ps "$name" 2>/dev/null | grep -qE "Up|running"; do
    retry_count=$((retry_count + 1))
    if [ $retry_count -ge $max_retries ]; then
      log_error "$name container failed to start after ${max_retries} attempts"
      log "Checking container logs..."
      cd "$PROJECT_ROOT/local" && docker compose logs "$name" --tail=50
      return 1
    fi
    sleep 2
  done
  log_success "$name container is running!"
  return 0
}

# Wait for control-plane container (not exposed on host port)
wait_for_container "control-plane" || exit 1

# Wait for metrics container (not exposed on host, just check it's running)
wait_for_container "metrics" || exit 1

# Wait for web-app API (exposed on host port 3000)
wait_for_service "web-app" "http://localhost:3000/api/health" || exit 1

log_success "All services are ready!"

# Step 6: Prompt for sudo password for daemon (only process that needs root)
log "Preparing to start development environment..."
if [ "$EUID" -ne 0 ]; then
  log_warn "Daemon requires sudo privileges. You'll be prompted for your password."
  log "Testing sudo access..."
  # Prompt for password upfront and cache it
  sudo -v
  # Keep sudo alive for the duration of the script
  while true; do sudo -n true; sleep 60; kill -0 "$$" || exit; done 2>/dev/null &
  SUDO_PID=$!
  log_success "Sudo access granted"
fi

# Step 7: Start all dev processes
log "Starting development environment..."
log_warn "File watching is enabled - services will rebuild automatically on code changes"
log ""
log "  📁 apps/web/{app,components,lib}  → rebuilds web-app container"
log "  📁 services/control-plane         → rebuilds control-plane container"
log "  📁 services/metrics               → rebuilds metrics container"
log "  📁 apps/vpn-server                → rebuilds vpn-node container"
log "  📁 packages/*                     → rebuilds dependent containers"
log ""

# Check if cargo-watch is installed for daemon hot reload
DAEMON_CMD="dev:daemon:watch"
if ! command -v cargo-watch >/dev/null 2>&1; then
  log_warn "cargo-watch not found. Installing it now..."
  if ! cargo install cargo-watch 2>&1; then
    log_warn "Failed to install cargo-watch. Daemon will run without hot reload."
    DAEMON_CMD="dev:daemon"
  else
    log_success "cargo-watch installed successfully"
  fi
fi

exec npx concurrently \
  --kill-others \
  --names "watch,desktop,daemon,stripe,studio" \
  --prefix-colors "blue,magenta,red,cyan,yellow" \
  "cd $PROJECT_ROOT/local && docker compose watch" \
  "cd $PROJECT_ROOT/apps/desktop && APP_CHANNEL=devel VITE_APP_CHANNEL=devel bun run dev" \
  "cd $PROJECT_ROOT/apps/desktop && APP_CHANNEL=devel VITE_APP_CHANNEL=devel sudo bun run $DAEMON_CMD" \
  "cd $PROJECT_ROOT && bun run dev:stripe" \
  "cd $PROJECT_ROOT && bun run dev:studio"
