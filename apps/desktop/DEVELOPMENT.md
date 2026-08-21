# Desktop App Development Guide

## Quick Start

### Terminal 1: Run the Daemon (with hot reload)

```bash
# With hot reload (requires cargo-watch)
sudo bun run dev:daemon:watch

# Or without hot reload
sudo bun run dev:daemon
```

### Terminal 2: Run the Tauri App

```bash
bun run dev
```

The app will automatically connect to the dev daemon at `/tmp/vpnvpn-daemon.sock`.

---

## Channels (prod / staging / devel)

- GUI reads `VITE_APP_CHANNEL`; backend (Tauri/Rust) reads `APP_CHANNEL`.
- Debug builds default to `devel`, release builds default to `prod`.
- Set `VITE_APP_CHANNEL=staging` and `APP_CHANNEL=staging` when building a staging desktop.
- The desktop only uses the bundled daemon binary for the current build; it does not download artifacts at runtime.

---

## Development Mode Details

### Dev Daemon Features

- **Socket Path**: `/tmp/vpnvpn-daemon.sock` (user-accessible)
- **Hot Reload**: Auto-restarts on code changes when using `cargo watch`
- **Colored Logs**: ANSI colors enabled for better readability
- **Debug Logging**: Use `--log-level debug` or `--log-level trace`

### Why Two Sockets?

| Mode | Socket Path | Requires Root | Use Case |
|------|-------------|---------------|----------|
| **Dev** | `/tmp/vpnvpn-daemon.sock` | For VPN ops only | Development |
| **Production** | `/var/run/vpnvpn-daemon.sock` | Yes | Real usage |

The Tauri app automatically prefers the dev socket if it exists, allowing you to:
1. Keep the production daemon installed
2. Run a dev daemon for testing without conflicts
3. Hot reload without touching the system service

### Available Commands

```bash
# Daemon development
bun run dev:daemon         # Run daemon in dev mode (once)
bun run dev:daemon:watch   # Run with hot reload
bun run build:daemon       # Build release daemon
bun run build:daemon:debug # Build debug daemon

# Full app development  
bun run dev                # Run Tauri + Vite
bun run dev:full           # Prints instructions for full stack dev
```

### Hot Reload Setup

Install cargo-watch:

```bash
cargo install cargo-watch
```

Then run with hot reload:

```bash
sudo cargo watch -c -w src -x 'run -- --dev --log-level debug'
```

Flags:
- `-c`: Clear screen before each run
- `-w src`: Watch only the src directory
- `-x`: Execute cargo command

### Daemon CLI Options

```
vpnvpn-daemon [OPTIONS]

Options:
  -d, --dev                    Run in development mode
      --socket <SOCKET>        Custom socket path (overrides default)
      --log-level <LOG_LEVEL>  trace, debug, info, warn, error [default: info]
  -h, --help                   Print help
  -V, --version                Print version
```

### Running Without Root

You can run the daemon without root for IPC testing:

```bash
cargo run -- --dev --log-level debug
```

VPN operations will fail, but you can still:
- Test IPC protocol
- Test GUI interactions
- Debug request/response handling

For full VPN functionality, run with `sudo`.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Desktop App                          │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐    IPC (JSON-RPC)    ┌─────────────────┐   │
│  │  Tauri GUI  │ ◄─────────────────► │  Daemon (Rust)  │   │
│  │ (unprivileged)│                    │   (privileged)  │   │
│  └─────────────┘                      └─────────────────┘   │
│         │                                     │              │
│         │ Vite Dev Server                     │ VPN Tools    │
│         ▼                                     ▼              │
│  ┌─────────────┐                      ┌─────────────────┐   │
│  │   React UI  │                      │ wg-quick/openvpn│   │
│  └─────────────┘                      └─────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Socket Priority

The Tauri app checks sockets in this order:
1. Dev socket (`/tmp/vpnvpn-daemon.sock`) - if exists, use it
2. Production socket (`/var/run/vpnvpn-daemon.sock`) - fallback

This allows seamless switching between dev and prod modes.

---

## Security model (IPC client authorization)

The daemon runs as root and must only accept IPC from the authorized GUI. The
authorization gates are:

- **Linux — peer UID allowlist.** The daemon authorizes connections by peer UID
  (`SO_PEERCRED`). The allowlist is `allowed_uids` in `daemon.json`, populated on
  first run from `SUDO_UID` / the socket directory owner, and always includes
  root (uid 0). It is **never** allow-all — an unknown UID is rejected. The socket
  is additionally chowned to the owning user with `0o600` (or `0o660` when the
  owner can't be resolved); it is never world-writable.
- **macOS — code signature + Team ID pinning.** The daemon verifies the
  connecting process via `codesign` (bundle id `com.vpnvpn.desktop`) and, in
  release builds, a pinned **Team ID**. Set `VPNVPN_EXPECTED_TEAM_ID=<Apple Team
  ID>` at build time. `daemon/build.rs` requires it for macOS release builds
  (set `VPNVPN_ALLOW_UNPINNED_TEAM_ID=1` for an unsigned/local release build).
  In debug builds the Team ID may be omitted so an ad-hoc-signed dev GUI works.
- **Windows — Authenticode.** The named-pipe client's image is verified via
  Authenticode (`#[cfg(windows)]`, validated in CI's `windows-check` job).

After transport-level authorization, privileged RPCs require a session token
bound to the connecting peer pid (challenge–response handshake).

### Config injection protection

Every attacker-influenced `VpnConfig` field is validated before any root-written
config file is produced (`daemon/src/vpn/validate.rs`): newlines, INI section
characters, and command-executing directives (`PostUp`/`PreUp`/`PostDown`/
`script-security`/`up`/`down`/…) are rejected, and keys/IPs/CIDRs/endpoints are
structurally validated. This prevents `wg-quick`/`openvpn`/`ipsec` from running
injected commands as root.

---

## Network routing settings

Configured in **Settings → General → Network Routing** (persisted to
`daemon.json`, applied on the next connection):

- **Auto-reconnect** (`auto_reconnect`): re-establish the last tunnel with
  capped exponential backoff after an unexpected drop. Suppressed after an
  explicit user disconnect.
- **Split tunneling** (`split_tunnel`): subnet-based include/exclude shaping of
  WireGuard `AllowedIPs`. Modes: `full` (default, `0.0.0.0/0, ::/0`), `include`
  (only listed subnets), `exclude` (everything except listed subnets; IPv4
  complement computed, IPv6 routed in full). Per-app routing is not supported.

---

## Troubleshooting

### "cargo-watch not found"

```bash
cargo install cargo-watch
```

### "Permission denied" connecting to socket

The daemon socket permissions are `0o666`. If you still get errors:

```bash
# Check socket permissions
ls -la /tmp/vpnvpn-daemon.sock

# Remove stale socket
rm /tmp/vpnvpn-daemon.sock
```

### VPN operations fail without root

This is expected. VPN operations require root privileges.
Run the daemon with `sudo` for full functionality.

### Dev daemon not being used

Check if the dev socket exists:

```bash
ls -la /tmp/vpnvpn-daemon.sock
```

The Tauri app logs which socket it's using:
```
[daemon_client] Using dev socket: /tmp/vpnvpn-daemon.sock
```

### Port conflicts

If Vite port 5173 is in use:

```bash
bun run dev:vite -- --port 5174
```

