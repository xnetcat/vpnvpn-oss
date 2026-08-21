# Prometheus (Railway)

Scrapes the VPN node(s)' `/metrics` endpoints and serves the Prometheus UI/API.
`docker-entrypoint.sh` generates the config from environment variables at
startup (Prometheus itself cannot expand env vars in its config).

## Target discovery

Prefer **auto-discovery**: point Prometheus at the control-plane's
`/metrics/targets` endpoint (Prometheus HTTP service discovery). Nodes appear
and disappear automatically as they register with the control plane — no static
list to maintain. A static list is supported as a fallback.

## Environment variables

| Variable | Required | Example | Notes |
|---|---|---|---|
| `CONTROL_PLANE_SD_URL` | for auto-discovery | `https://<control-plane>/metrics/targets` | Prometheus http_sd endpoint. |
| `CONTROL_PLANE_API_KEY` | with SD | `<api key>` | Bearer credentials for the SD endpoint (same key as the control plane). |
| `VPN_NODE_METRICS_TARGETS` | fallback only | `46.224.144.163:8080` | Static comma-separated `host:port` list, used if `CONTROL_PLANE_SD_URL` is unset. |
| `ENV_LABEL` | no | `staging` | `env` label for static targets (default `staging`). |
| `PORT` | no | `8080` | Listen port. Railway injects this automatically. |

The control plane derives each node's scrape address as
`<publicIp>:METRICS_TARGET_PORT` (default `8080`, the node `ADMIN_PORT`), so set
`METRICS_TARGET_PORT` on the control-plane service if the nodes use a different
admin port.

## Deploy to Railway

The Railway CLI/MCP token must be valid first (`railway login`).

1. In the `vpnvpn-staging` project, create a new service from this repo.
2. Set the service **Root Directory** to `infra/prometheus` (so this folder's
   `railway.toml` + `Dockerfile` are used).
3. Set the variable `VPN_NODE_METRICS_TARGETS=46.224.144.163:8080`
   (add more nodes comma-separated as the fleet grows).
4. Deploy. Generate a public domain to reach the Prometheus UI.

CLI equivalent from this directory:

```sh
railway link            # select the vpnvpn-staging project/environment
railway up              # build & deploy this Dockerfile
railway variables --set VPN_NODE_METRICS_TARGETS=46.224.144.163:8080
railway domain          # expose the UI
```

## Security note

The node `/metrics` endpoint is unauthenticated and the data is low-sensitivity
(session counts, byte totals). If you expose this Prometheus publicly, put it
behind Railway's access controls or front it with an authenticated Grafana and
keep Prometheus private (no public domain) — Grafana reaches it over Railway's
private network.

## Local stack

For local development, Prometheus + Grafana are already wired into
`local/compose.yaml` (`docker compose -f local/compose.yaml up`): Prometheus on
`:9091`, Grafana on `:3001` with an auto-provisioned dashboard.
