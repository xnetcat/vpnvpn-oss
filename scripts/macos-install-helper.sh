#!/usr/bin/env bash
# =============================================================================
# vpnVPN macOS Installation Helper
# =============================================================================
# This script helps users install vpnVPN Desktop on macOS by removing
# quarantine attributes that cause Gatekeeper to block the app.
#
# Usage:
#   1. Download this script and the app (DMG or .app.zip)
#   2. Run: bash macos-install-helper.sh
#   3. Follow the prompts
# =============================================================================

set -euo pipefail

echo "🚀 vpnVPN Desktop - macOS Installation Helper"
echo "=============================================="
echo ""

# Detect app in Downloads folder
DOWNLOADS="$HOME/Downloads"
APP_NAME="vpnVPN Desktop"
STAGING_APP_NAME="vpnVPN Desktop (Staging)"

find_app() {
  local name="$1"
  # Check for .app in Downloads
  if [[ -d "$DOWNLOADS/$name.app" ]]; then
    echo "$DOWNLOADS/$name.app"
    return 0
  fi
  # Check for mounted DMG
  if [[ -d "/Volumes/$name/$name.app" ]]; then
    echo "/Volumes/$name/$name.app"
    return 0
  fi
  # Check in Applications
  if [[ -d "/Applications/$name.app" ]]; then
    echo "/Applications/$name.app"
    return 0
  fi
  return 1
}

APP_PATH=""
if APP_PATH=$(find_app "$APP_NAME"); then
  echo "✅ Found: $APP_PATH"
elif APP_PATH=$(find_app "$STAGING_APP_NAME"); then
  echo "✅ Found: $APP_PATH"
else
  echo "❌ Could not find vpnVPN Desktop app."
  echo ""
  echo "Please ensure you've downloaded and extracted the app to one of:"
  echo "  • $DOWNLOADS"
  echo "  • /Applications"
  echo "  • Or mount the DMG file"
  echo ""
  read -p "Enter the full path to the .app: " APP_PATH
  
  if [[ ! -d "$APP_PATH" ]]; then
    echo "❌ Invalid path. Exiting."
    exit 1
  fi
fi

echo ""
echo "🔓 Removing macOS quarantine attributes..."
echo "   (This allows the app to open without the 'damaged' error)"
echo ""

# Remove quarantine attribute
if xattr -cr "$APP_PATH"; then
  echo "✅ Quarantine removed successfully!"
else
  echo "⚠️  Warning: Could not remove quarantine (may need sudo)"
  echo ""
  read -p "Try with sudo? (y/n): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    sudo xattr -cr "$APP_PATH"
    echo "✅ Quarantine removed with elevated privileges"
  fi
fi

# Copy to Applications if not already there
if [[ "$APP_PATH" != "/Applications/"* ]]; then
  echo ""
  read -p "📁 Copy to Applications folder? (y/n): " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    cp -R "$APP_PATH" /Applications/
    APP_PATH="/Applications/$(basename "$APP_PATH")"
    echo "✅ Copied to $APP_PATH"
  fi
fi

echo ""
echo "🎉 Installation complete!"
echo ""
echo "You can now open vpnVPN Desktop from:"
echo "  • Spotlight (Cmd+Space, type 'vpnVPN')"
echo "  • Applications folder"
echo "  • Or run: open \"$APP_PATH\""
echo ""
echo "ℹ️  First launch: If you still see a warning, right-click the app"
echo "   and select 'Open' instead of double-clicking."
echo ""

# Offer to open now
read -p "🚀 Open vpnVPN Desktop now? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  open "$APP_PATH"
  echo "✅ Opening vpnVPN Desktop..."
fi
