#!/bin/bash
# Development script for the vpnVPN daemon with hot reload
#
# Usage:
#   ./scripts/dev.sh          # Run with hot reload (requires cargo-watch)
#   ./scripts/dev.sh --once   # Run once without hot reload
#   ./scripts/dev.sh --debug  # Run with debug logging
#
# Prerequisites:
#   cargo install cargo-watch
#
# This runs the daemon in development mode which:
# - Uses /tmp/vpnvpn-daemon.sock (user-accessible)
# - Enables colored logging
# - Auto-restarts on code changes (with cargo-watch)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_DIR="$(dirname "$SCRIPT_DIR")"

cd "$DAEMON_DIR"

# Parse arguments
HOT_RELOAD=true
LOG_LEVEL="info"

for arg in "$@"; do
    case $arg in
        --once)
            HOT_RELOAD=false
            ;;
        --debug)
            LOG_LEVEL="debug"
            ;;
        --trace)
            LOG_LEVEL="trace"
            ;;
        *)
            ;;
    esac
done

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "❌ Error: This daemon requires root privileges for VPN operations."
    echo "   Please run with sudo:"
    echo "   sudo $0 $*"
    echo ""
    echo "   Or from the desktop app directory:"
    echo "   sudo ./scripts/dev-daemon.sh $*"
    exit 1
fi

# Clean up any existing dev socket
rm -f /tmp/vpnvpn-daemon.sock

if [ "$HOT_RELOAD" = true ]; then
    # Check for cargo-watch
    if ! command -v cargo-watch &> /dev/null; then
        echo "❌ cargo-watch not found. Install it with:"
        echo "   cargo install cargo-watch"
        echo ""
        echo "Or run without hot reload:"
        echo "   $0 --once"
        exit 1
    fi
    
    echo "🔥 Starting daemon in dev mode with hot reload..."
    echo "   Socket: /tmp/vpnvpn-daemon.sock"
    echo "   Log level: $LOG_LEVEL"
    echo "   Press Ctrl+C to stop"
    echo ""
    
    # Run with cargo-watch for hot reload
    # -c: Clear screen before each run
    # -w src: Watch src directory
    # -x: Execute cargo command
    cargo watch -c -w src -x "run -- --dev --log-level $LOG_LEVEL"
else
    echo "🚀 Starting daemon in dev mode (once)..."
    echo "   Socket: /tmp/vpnvpn-daemon.sock"
    echo "   Log level: $LOG_LEVEL"
    echo ""
    
    cargo run -- --dev --log-level "$LOG_LEVEL"
fi

