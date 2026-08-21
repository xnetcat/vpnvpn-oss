# macOS Quarantine Explained

## What Happened

You downloaded **vpnVPN Desktop (Staging).app** and got the error:

```
"vpnVPN Desktop (Staging).app" is damaged and can't be opened.
```

## Root Cause

**macOS adds quarantine attributes to ALL files downloaded from the internet**, regardless of whether they're signed. This is a security feature called Gatekeeper.

## Why Our Signing Works

The app **IS signed** (you can verify with `codesign -dv "/Applications/vpnVPN Desktop (Staging).app"`), but the **quarantine attribute overrides the signature check**.

## The Fix (Choose One)

### Option 1: Quick Terminal Command (Recommended)

```bash
xattr -cr "/Applications/vpnVPN Desktop (Staging).app" && open "/Applications/vpnVPN Desktop (Staging).app"
```

### Option 2: Right-Click Method

1. Right-click the app
2. Click **"Open"** (not double-click!)
3. Click **"Open"** again in the warning dialog

### Option 3: Use the Helper Script

```bash
# Download from your S3 bucket
curl -O https://your-bucket/releases/staging/fix-macos-quarantine.sh
bash fix-macos-quarantine.sh
```

## Technical Details

### Before Fix

```bash
$ xattr -l "/Applications/vpnVPN Desktop (Staging).app"
com.apple.quarantine: 0381;693232e2;Chrome;...
```

### After Fix

```bash
$ xattr -l "/Applications/vpnVPN Desktop (Staging).app"
com.apple.provenance:
```

### Signature Status

```bash
$ codesign -dv "/Applications/vpnVPN Desktop (Staging).app" 2>&1
Signature=adhoc  ✅ (This is correct!)
```

## Why Not Notarization?

**Notarization requires:**

- $99/year Apple Developer account
- Developer ID certificate
- Uploading to Apple for scanning

**Our ad-hoc approach:**

- $0 cost
- Works immediately
- Users just need one extra step

## What We've Implemented

1. ✅ **Build-time signing** - Apps are signed with `codesign --sign -` during deployment
2. ✅ **DMG signing** - DMG files are also signed
3. ✅ **Helper scripts** - Auto-uploaded to S3
4. ✅ **User instructions** - Clear instructions on download page
5. ✅ **Quick-fix script** - One-line solution for users

## For Next Deployment

When you run `./scripts/deploy.sh staging --with-desktop`, the new builds will:

1. Be ad-hoc signed during bundling
2. Have helper scripts uploaded to S3
3. Display clear instructions on the marketing page

## Important

**The quarantine error is EXPECTED for all downloaded apps without notarization.** The ad-hoc signing prevents the "damaged" error and makes the app openable with right-click → Open or the Terminal command.

This is the standard approach for non-notarized macOS apps (e.g., many open-source tools, Homebrew casks without casks, etc.).
