# vpn-server (Rust VPN node agent)

High-performance VPN node agent written in Rust, managing WireGuard, OpenVPN, and IKEv2 on host machines.

It is designed to run:

- On EC2 instances or container hosts as a Docker container.
- On generic Linux/macOS/Windows servers as a binary.

## Supported Platforms

| Platform    | Support Status | Requirements                                                                |
| ----------- | -------------- | --------------------------------------------------------------------------- |
| **Linux**   | ✅ First-class | Kernel WireGuard or `wireguard-go`, OpenVPN, strongSwan/swanctl, `iproute2` |
| **macOS**   | ✅ Supported   | `brew install wireguard-tools wireguard-go openvpn`                         |
| **Windows** | ⚠️ Beta        | WireGuard for Windows + OpenVPN client, admin rights                        |

On all platforms, the process must have permission to create TUN/TAP interfaces and manage VPN daemons.

## Prerequisites

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install wireguard wireguard-tools wireguard-dkms wireguard-go \
  openvpn strongswan swanctl iproute2
```

### macOS

```bash
brew install wireguard-tools wireguard-go openvpn
# strongSwan support on macOS is limited; IKEv2 is primarily targeted at Linux.
```

### Windows

1. Install [WireGuard for Windows](https://www.wireguard.com/install/).
2. Ensure `wireguard.exe` is in your PATH.
3. Install [OpenVPN Connect](https://openvpn.net/client-connect-vpn-for-windows/) if using OpenVPN.
4. Run shells as Administrator to allow TUN/TAP operations.

## CLI usage (no `.env` required)

The preferred configuration method is via CLI subcommands and flags.

### Run mode

```bash
cargo build --release
./target/release/vpn-server run \
  --api-url https://your-control-plane.example.com \
  --token <NODE_TOKEN> \
  --listen-port 51820 \
  --protocol wireguard --protocol openvpn --protocol ikev2
```

Supported options (high level):

- `--api-url` – control-plane base URL (required).
- `--token` – node registration token issued by the control plane (required).
- `--listen-port` – UDP port for WireGuard (default: 51820).
- `--protocol` – repeatable flag to enable `wireguard`, `openvpn`, and/or `ikev2`.

Environment variables (optional convenience):

- `API_URL` – same as `--api-url`.
- `VPN_TOKEN` – same as `--token`.
- `VPN_PROTOCOLS` – comma-separated protocol list, e.g. `wireguard,openvpn,ikev2`.

> In production we recommend passing configuration via CLI or orchestrator config, not `.env` files on disk.

### Doctor mode

`doctor` checks prerequisites and prints a concise report:

```bash
./target/release/vpn-server doctor
```

Checks performed (per OS):

- Presence and versions of `wg`, `wireguard-go`, `openvpn`, `ipsec`/`swanctl`.
- Ability to create and manage TUN/TAP devices.
- Required kernel modules (Linux).
- Optional: AWS metadata and IAM role availability when running on EC2.

The command exits with non-zero status if critical requirements are missing, and prints privacy-safe hints for remediation.

## Architecture

The server uses a modular backend system:

- **WireGuard**
  - Linux: uses kernel module if available; falls back to `wireguard-go`.
  - macOS: uses `wireguard-go` (userspace).
  - Windows: controls `wireguard.exe` tunnel services.
- **OpenVPN**
  - Manages an OpenVPN server process, generating self-signed certificates for development.
  - Reads the OpenVPN status file to derive aggregate session counts and bytes.
- **IKEv2/IPsec**
  - Targets strongSwan/swanctl on Linux, configuring a generic IKEv2-PSK profile.
  - Reports aggregate active tunnels (no per-client details).

The control-plane integration is handled via an async loop that:

1. Registers the node on startup (`POST /server/register`).
2. Periodically syncs peers (`GET /server/peers`) and applies them to all enabled backends.
3. Periodically sends aggregate metrics (`POST /server/heartbeat`) and publishes CloudWatch metrics.

## Cross-Platform Notes

- On **Windows**, run `vpn-server` with **Administrator privileges** to manage network interfaces and services.
- On **macOS/Linux**, `sudo` is generally required to manipulate `utun`/`tun` devices and to spawn VPN daemons.
- The agent's own structured logs are designed to avoid PII: only aggregate counts and operational events are emitted, and credentials/keys are redacted (no client IPs or traffic contents). The managed daemons still keep minimal operational artifacts on the node itself — notably the OpenVPN status file (`/var/run/openvpn-status.log`, restricted to `0600`), which lists connected clients' addresses and is used to derive aggregate session metrics. Traffic contents are never logged anywhere.
