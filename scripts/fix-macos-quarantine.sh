#!/usr/bin/env bash
# Quick fix for "damaged" error - removes quarantine from vpnVPN Desktop app
# Usage: bash fix-macos-quarantine.sh

APP_PATHS=(
  "/Applications/vpnVPN Desktop.app"
  "/Applications/vpnVPN Desktop (Staging).app"
  "$HOME/Downloads/vpnVPN Desktop.app"
  "$HOME/Downloads/vpnVPN Desktop (Staging).app"
)

echo "🔍 Searching for vpnVPN Desktop..."

FOUND=false
for APP in "${APP_PATHS[@]}"; do
  if [[ -d "$APP" ]]; then
    echo "✅ Found: $APP"
    echo "🔓 Removing quarantine..."
    if xattr -cr "$APP"; then
      echo "✅ Quarantine removed! You can now open the app."
      FOUND=true
    else
      echo "⚠️  Failed to remove quarantine. Try with sudo:"
      echo "   sudo xattr -cr \"$APP\""
    fi
    echo ""
  fi
done

if [[ "$FOUND" == "false" ]]; then
  echo "❌ vpnVPN Desktop not found in common locations."
  echo ""
  echo "To fix manually, run:"
  echo '  xattr -cr "/path/to/vpnVPN Desktop.app"'
  echo ""
  echo "Then try opening the app again."
fi
