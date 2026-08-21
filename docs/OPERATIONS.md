# Operations & Runbook

This guide covers the operational aspects of vpnVPN, including VPN node management, maintenance procedures, and troubleshooting.

## 1. VPN Node Management

### Architecture

VPN Nodes run as Docker containers on manually provisioned VMs. They register with the **Control Plane** (Railway) and report metrics via `POST /metrics/vpn` → stored in PostgreSQL.

### Adding a Node

```bash
# On the target VM
export CONTROL_PLANE_URL="https://vpnvpn-control-plane-staging.up.railway.app"
export VPN_TOKEN="your-token"
sudo -E bash scripts/setup-vpn-node.sh
```

### Removing a Node

```bash
# Stop the container
docker stop vpn-server && docker rm vpn-server

# Remove from control plane
curl -X DELETE "https://vpnvpn-control-plane-staging.up.railway.app/servers/<server-id>" -H "X-API-Key: <key>"
```

### Monitoring

- **Health Check:** `http://<NODE_IP>:8080/health`
- **Metrics:** `http://<NODE_IP>:8080/metrics` (Prometheus format)
- **Logs:** `docker logs vpn-server`
---

## 2. Maintenance Procedures

### Backup & Recovery

| Component    | Method                  | Frequency  | Retention |
| :----------- | :---------------------- | :--------- | :-------- |
| **Database** | Neon Auto-Backup (PITR) | Continuous | 30 Days   |

**Database Restore:** Use Neon Console to create a branch from a point-in-time.

### Certificate Rotation

- **VPN Server Keys:** Persisted in `/etc/vpnvpn/pki/` on nodes. To rotate, delete the PKI directory and restart the container.
- **VPN Tokens:**
  1. Generate new token via Admin API (`POST /tokens`).
  2. Update `VPN_TOKEN` on each node and restart.

### Updates

- **VPN Server:** Pull new image from GHCR and restart the container.
  ```bash
  docker pull ghcr.io/xnetcat/vpnvpn/vpn-server:latest
  docker stop vpn-server && docker rm vpn-server
  # Re-run docker run command from setup
  ```
- **Control Plane:** Push to main/staging branch (Railway auto-deploys).

---

## 3. Troubleshooting

### Common Issues

#### Node Won't Register

- **Symptom:** Logs show `registration_failed`.
- **Check:**
  - Is `VPN_TOKEN` correct?
  - Is `API_URL` reachable from the node?
  - Is the Control Plane healthy? (`curl https://vpnvpn-control-plane-staging.up.railway.app/health`)

#### Clients Can't Connect

- **Symptom:** Handshake fails.
- **Check:**
  - Firewall allowing UDP 51820 (WireGuard), 1194 (OpenVPN), 500/4500 (IKEv2)?
  - Client config matches Server Public Key?
  - Node healthy? (`curl http://localhost:8080/health`)

#### Database Connection Errors

- **Symptom:** Control plane 500 errors.
- **Check:**
  - Neon status.
  - Railway service logs.
  - Connection pool exhaustion (check Neon dashboard).

### Diagnostic Commands

```bash
# Check Node Health
curl http://<NODE_IP>:8080/health

# Check Node Status
curl http://<NODE_IP>:8080/status

# Check Node Metrics
curl http://<NODE_IP>:8080/metrics

# Check Control Plane Health
curl https://vpnvpn-control-plane-staging.up.railway.app/health

# View Node Logs
docker logs vpn-server --tail 100
```

### Escalation

1. Review Railway deployment logs.
3. Check Database status (Neon).
4. Contact Platform Lead.
