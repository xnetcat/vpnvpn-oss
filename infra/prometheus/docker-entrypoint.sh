#!/bin/sh
# Render the Prometheus config from environment variables, then exec Prometheus.
#
# Target discovery (pick one):
#   CONTROL_PLANE_SD_URL   Prometheus HTTP service discovery — the control-plane
#                          /metrics/targets endpoint. Nodes are discovered
#                          automatically as they register. Authenticated with
#                          CONTROL_PLANE_API_KEY (Bearer).
#   VPN_NODE_METRICS_TARGETS  Static fallback: comma-separated host:port list.
#
# Optional:
#   CONTROL_PLANE_API_KEY  Bearer credentials for the SD endpoint.
#   ENV_LABEL              `env` label for static targets (default: staging).
#   PORT                   listen port (Railway injects this; default 9090).
set -eu

PORT="${PORT:-9090}"
ENV_LABEL="${ENV_LABEL:-staging}"
CONFIG=/tmp/prometheus.yml

{
  echo "global:"
  echo "  scrape_interval: 15s"
  echo "  evaluation_interval: 15s"
  echo "scrape_configs:"
  echo "  - job_name: prometheus"
  echo "    static_configs:"
  echo "      - targets: [\"localhost:${PORT}\"]"

  if [ -n "${CONTROL_PLANE_SD_URL:-}" ]; then
    # Auto-discover the node fleet from the control plane.
    echo "  - job_name: vpn-nodes"
    echo "    metrics_path: /metrics"
    echo "    http_sd_configs:"
    echo "      - url: ${CONTROL_PLANE_SD_URL}"
    echo "        refresh_interval: 30s"
    if [ -n "${CONTROL_PLANE_API_KEY:-}" ]; then
      echo "        authorization:"
      echo "          type: Bearer"
      echo "          credentials: ${CONTROL_PLANE_API_KEY}"
    fi
  elif [ -n "${VPN_NODE_METRICS_TARGETS:-}" ]; then
    # Static fallback. Turn "a:1,b:2" into an inline YAML array.
    TARGETS_YAML=$(printf '%s' "$VPN_NODE_METRICS_TARGETS" | awk -F, '{
      out=""
      for (i = 1; i <= NF; i++) {
        gsub(/^[ \t]+|[ \t]+$/, "", $i)
        if ($i == "") continue
        out = out (out == "" ? "" : ", ") "\"" $i "\""
      }
      print out
    }')
    echo "  - job_name: vpn-node"
    echo "    metrics_path: /metrics"
    echo "    static_configs:"
    echo "      - targets: [${TARGETS_YAML}]"
    echo "        labels:"
    echo "          env: ${ENV_LABEL}"
  else
    echo "[entrypoint] set CONTROL_PLANE_SD_URL (auto-discovery) or VPN_NODE_METRICS_TARGETS (static)" >&2
    exit 1
  fi
} > "$CONFIG"

echo "[entrypoint] rendered prometheus.yml:"
# Redact the bearer credentials before logging.
sed 's/\(credentials: \).*/\1<redacted>/' "$CONFIG"

exec /bin/prometheus \
  --config.file="$CONFIG" \
  --storage.tsdb.path=/prometheus \
  --web.listen-address=":${PORT}" \
  "$@"
