#!/bin/sh
set -eu
# Usage: ./start_endpoint.sh [iface]
IFACE="${1:-wg0}"
HTTP_ADDR="${HTTP_ADDR:-127.0.0.1:8080}"
CLIENT_CONF="${CLIENT_CONF:-/tmp/MapleSprint.conf}"
HUD_URL="${HUD_URL:-https://sdoolman.github.io/maplesprint-hud/}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${ROOT_DIR}/forwarder/maplesprint-endpoint"

if [ ! -x "$BIN" ] || [ "${ROOT_DIR}/forwarder/main.go" -nt "$BIN" ]; then
  echo "Building open-source maplesprint-endpoint..."
  (cd "${ROOT_DIR}/forwarder" && CGO_ENABLED=0 go build -trimpath -o "$BIN" .)
fi

LOCAL_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}' || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")"

echo "==> MapleSprint Open-Source Local Endpoint"
echo "    Endpoint API : http://${HTTP_ADDR}/status"
echo "    Dashboard UI : ${HUD_URL}?endpoint=http://${HTTP_ADDR}"

exec "$BIN" \
  --iface "$IFACE" \
  --http "$HTTP_ADDR" \
  --outbound-ip "$LOCAL_IP" \
  --client-conf "$CLIENT_CONF" \
  --hud-url "$HUD_URL"
