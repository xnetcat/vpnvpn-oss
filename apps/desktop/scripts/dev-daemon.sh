#!/bin/bash
# Quick launcher for daemon development with hot reload
#
# Usage:
#   sudo ./scripts/dev-daemon.sh              # Start daemon with hot reload (REQUIRES SUDO)
#   sudo ./scripts/dev-daemon.sh --debug      # Debug logging
#   sudo ./scripts/dev-daemon.sh --once       # Run once without hot reload
#
# In another terminal, run the Tauri app:
#   bun run dev
#
# The app will automatically connect to the dev daemon at /tmp/vpnvpn-daemon.sock

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_SCRIPT="$SCRIPT_DIR/../daemon/scripts/dev.sh"

# Ensure script is executable
chmod +x "$DAEMON_SCRIPT"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "❌ Error: This daemon requires root privileges."
    echo "   Please run with sudo:"
    echo "   sudo $0 $*"
    exit 1
fi

exec "$DAEMON_SCRIPT" "$@"

