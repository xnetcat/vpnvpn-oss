# Local Development Changelog

## 2025-11-21 - Full Stack Local Dev Support

### 🎉 Major Framework Rework

#### 1. Full Stack Integration
- **Web App (Next.js)** is now part of the local dev stack.
- `test-flow.sh` now starts:
  - Postgres (Docker)
  - Mock API (Node)
  - Web App (Native)
  - VPN Server (Native)
- Automatic environment configuration (`.env.local`) and database migrations.

#### 2. Mock API Updates
- Added endpoints to support Web App control plane calls:
  - `POST /peers`
  - `POST /peers/revoke-for-user`
  - `DELETE /peers/:publicKey`
- Ensured compatibility with `lib/controlPlane.ts`.

#### 3. Script Updates
- `test-flow.sh`:
  - Default mode is now **Dev Stack** (everything local + Docker DB).
  - `--docker` flag preserves original Docker-only mode.
  - Background process management and cleanup.
- `run-tests.sh`: New script to run E2E tests against the running stack.

#### 4. Documentation
- Updated `FEATURES.md` to reflect the new full-stack capabilities.
- Updated `README.md` usage instructions.

### 📝 Modified Files
- `local/test-flow.sh`: Complete rewrite for full stack support.
- `local/mock-api/index.js`: Added Web App endpoints.
- `local/run-tests.sh`: New test runner.
- `web-app/.env.local` (Generated): Automatic config.

### 🚀 Usage
```bash
# Start everything
./test-flow.sh

# Run tests (in new terminal)
./run-tests.sh
```

### 💡 Previous Changes
- Added Local Mode Testing (`--local` flag)
- Enhanced Mock API with Dashboard
- Added E2E Test Suite
