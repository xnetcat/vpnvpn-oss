#!/usr/bin/env bash
# =============================================================================
# macOS Ad-hoc Signing Script
# =============================================================================
# This script applies ad-hoc code signing to the macOS app bundle.
# While this doesn't satisfy Apple's notarization requirements, it prevents
# the "damaged" error and makes the app openable via right-click > Open.
#
# Usage: ./sign-macos.sh /path/to/App.app
# =============================================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/App.app"
  exit 1
fi

APP_PATH="$1"

if [[ ! -d "$APP_PATH" ]]; then
  echo "Error: App bundle not found at $APP_PATH"
  exit 1
fi

echo "🔐 Applying ad-hoc signature to $(basename "$APP_PATH")..."

# Remove existing quarantine attributes (if any from development)
xattr -cr "$APP_PATH" 2>/dev/null || true

# Sign nested binaries first (daemon, helpers, etc.)
echo "🔐 Signing nested binaries..."
if [ -d "$APP_PATH/Contents/MacOS" ]; then
  for binary in "$APP_PATH/Contents/MacOS"/*; do
    if [ -f "$binary" ] && [ -x "$binary" ]; then
      echo "  → Signing $(basename "$binary")..."
      codesign --force --sign - "$binary" 2>/dev/null || true
    fi
  done
fi

# Apply ad-hoc signature to the main app bundle
# Note: NOT using --deep because it breaks resource sealing
echo "🔐 Signing main app bundle..."
codesign --force --sign - "$APP_PATH"

echo "✅ Ad-hoc signature applied successfully"
echo ""
echo "ℹ️  This app can now be opened by:"
echo "   1. Right-click → Open (first time only)"
echo "   2. Or run: xattr -cr \"$APP_PATH\" && open \"$APP_PATH\""
