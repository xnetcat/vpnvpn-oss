# Desktop App Environment Variables - Critical Fix

## Problem Found

The desktop app build was **failing to bundle the correct API URLs** because of an environment variable name mismatch.

### What Was Wrong

**Deploy script was setting:**

```bash
export VITE_VPNVPN_DESKTOP_URL="${DESKTOP_URL}"
export VITE_VPNVPN_API_URL="${WEB_URL}"
```

**But desktop app expects:**

```typescript
// src/lib/config.ts
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export const DASHBOARD_URL =
  import.meta.env.VITE_DASHBOARD_URL ?? `${API_BASE_URL}/dashboard`;
```

### Impact

❌ **Before fix:**

- Desktop app used `http://localhost:3000` (fallback)
- Users couldn't authenticate (API calls went to localhost)
- VPN connection failed (no backend)

✅ **After fix:**

- Desktop app uses correct staging/production URLs
- `VITE_API_BASE_URL` = `https://staging.vpnvpn.dev` (staging)
- `VITE_DASHBOARD_URL` = `https://staging.vpnvpn.dev/desktop?desktop=1`

## The Fix

Updated [scripts/deploy.sh](file:///Users/xnetcat/Projects/xnetcat/vpnVPN/scripts/deploy.sh#L370-L378):

```diff
  # Set environment variables for build - these get hardcoded into the bundle
+ # Note: Desktop app uses VITE_API_BASE_URL (see src/lib/config.ts)
- export VITE_VPNVPN_DESKTOP_URL="${DESKTOP_URL}"
- export VITE_VPNVPN_API_URL="${WEB_URL}"
+ export VITE_API_BASE_URL="${WEB_URL}"
+ export VITE_DASHBOARD_URL="${DESKTOP_URL}"

- log_info "Desktop URL: ${DESKTOP_URL}"
- log_info "API URL: ${WEB_URL}"
+ log_info "API Base URL: ${WEB_URL}"
+ log_info "Dashboard URL: ${DESKTOP_URL}"
```

## Environment Variable Reference

### Staging

```bash
VITE_API_BASE_URL=https://staging.vpnvpn.dev
VITE_DASHBOARD_URL=https://staging.vpnvpn.dev/desktop?desktop=1
```

### Production

```bash
VITE_API_BASE_URL=https://vpnvpn.dev
VITE_DASHBOARD_URL=https://vpnvpn.dev/desktop?desktop=1
```

## How to Verify

After the next build, check that the desktop app is using the correct URLs:

### During Build

Look for this in deploy logs:

```
[INFO] API Base URL: https://staging.vpnvpn.dev
[INFO] Dashboard URL: https://staging.vpnvpn.dev/desktop?desktop=1
```

### In App Console

When you open the app, check the developer console (if available):

```
[config] Environment loaded:
[config]   API_BASE_URL: https://staging.vpnvpn.dev
```

### Test Authentication

1. Launch desktop app
2. Enter email for OTP
3. Should call: `https://staging.vpnvpn.dev/api/auth/otp/send`
4. NOT: `http://localhost:3000/api/auth/otp/send`

## Related Files

- [apps/desktop/src/lib/config.ts](file:///Users/xnetcat/Projects/xnetcat/vpnVPN/apps/desktop/src/lib/config.ts) - Environment variable definitions
- [apps/desktop/src/App.tsx](file:///Users/xnetcat/Projects/xnetcat/vpnVPN/apps/desktop/src/App.tsx#L68) - API calls using `API_BASE_URL`
- [scripts/deploy.sh](file:///Users/xnetcat/Projects/xnetcat/vpnVPN/scripts/deploy.sh#L370-L378) - Environment variable export

## Next Steps

**The deployment that's currently running used the OLD environment variables.** You'll need to:

1. ✅ Re-run deployment with fixed variables:

   ```bash
   ./scripts/deploy.sh staging --only-desktop
   ```

2. ✅ Download and test the new build

3. ✅ Verify API calls go to staging URLs (not localhost)
