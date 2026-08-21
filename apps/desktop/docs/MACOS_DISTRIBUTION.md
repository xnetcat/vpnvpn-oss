# macOS Distribution Without Apple Developer Account

This document explains how vpnVPN Desktop is distributed on macOS without requiring a $99/year Apple Developer account.

## The Problem

macOS Gatekeeper blocks unsigned apps with the error: `"vpnVPN Desktop.app" is damaged and can't be opened.`

## Our Solution (Free)

We use **ad-hoc code signing** during the build process, which:

- ✅ Removes the "damaged" error
- ✅ Allows users to open the app via right-click → Open
- ✅ Requires no Apple Developer account
- ❌ Does NOT pass full Gatekeeper verification (users see a warning on first launch)

## Implementation

### 1. Build-Time Signing

The [`scripts/deploy.sh`](../../scripts/deploy.sh) automatically signs macOS app bundles:

```bash
# Remove quarantine attributes
xattr -cr "/path/to/App.app"

# Apply ad-hoc signature (no identity required)
codesign --force --deep --sign - "/path/to/App.app"
```

### 2. User Instructions

The [marketing page](<../../apps/web/app/(marketing)/page.tsx>) displays clear instructions:

- **Quick fix**: Right-click → Open (bypasses Gatekeeper warning)
- **Terminal command**: `xattr -cr "/Applications/vpnVPN Desktop.app"`
- **Helper script**: Download automated installer that handles everything

### 3. Helper Scripts

**For developers** - [`apps/desktop/scripts/sign-macos.sh`](../scripts/sign-macos.sh):

```bash
./sign-macos.sh "/path/to/App.app"
```

**For users** - [`scripts/macos-install-helper.sh`](../../scripts/macos-install-helper.sh):

- Auto-detects the app in Downloads/Applications
- Removes quarantine attributes
- Optionally copies to Applications folder
- Offers to launch the app

This script is automatically uploaded to S3 with each deployment.

## User Experience

### First Launch Flow

1. User downloads DMG/ZIP from website
2. User sees Gatekeeper warning on first launch
3. User follows one of three paths:
   - Right-click → Open
   - Run Terminal command
   - Download and run helper script

### After First Launch

No warnings on subsequent launches.

## Alternative: Paid Notarization

If you want a seamless user experience (no warnings), you'll need:

1. **Apple Developer Account** - $99/year
2. **Developer ID Application Certificate**
3. **Notarization** via `xcrun notarytool`

Update `tauri.conf.json`:

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
      "entitlements": "path/to/entitlements.plist"
    }
  }
}
```

## Testing Locally

After building your app:

```bash
# Check current signature
codesign --verify --verbose "/path/to/App.app"

# Check quarantine attributes
xattr -l "/path/to/App.app"

# Remove quarantine
xattr -cr "/path/to/App.app"

# Sign ad-hoc
codesign --force --deep --sign - "/path/to/App.app"

# Verify signature
codesign --verify --verbose "/path/to/App.app"
```

## FAQ

**Q: Why do users see a warning?**  
A: Ad-hoc signing prevents the "damaged" error but doesn't satisfy notarization. Only Apple-notarized apps open without warnings.

**Q: Is this safe?**  
A: Yes. Ad-hoc signing is legitimate and widely used for internal distribution. Users just need to explicitly approve the app once.

**Q: Can I automate this for users?**  
A: Not entirely. macOS security requires user interaction for first launch of unsigned apps. Our helper script minimizes steps but can't bypass the warning entirely.

**Q: What about Windows/Linux?**  
A: No issues! Only macOS has this restriction. Windows SmartScreen may show a warning, but it's less aggressive.

## Resources

- [Apple Code Signing Guide](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/)
- [Tauri macOS Signing](https://tauri.app/v1/guides/distribution/sign-macos/)
- [Gatekeeper Explained](https://support.apple.com/en-us/HT202491)
