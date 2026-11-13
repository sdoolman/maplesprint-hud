#!/bin/sh
set -eu
# Usage: ./start_endpoint.sh <worker_url> [room_id] [iface]
WORKER_URL="${1:?Usage: $0 <worker_url> [room_id] [iface]}"
ROOM_ID="${2:-default}"
IFACE="${3:-wg0}"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BIN="${ROOT_DIR}/forwarder/wg-forwarder"

if [ ! -x "$BIN" ]; then
  echo "Building wg-forwarder..."
  (cd "${ROOT_DIR}/forwarder" && CGO_ENABLED=0 go build -o "$BIN" .)
fi

sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null
exec sudo "$BIN" \
  --worker "$WORKER_URL" \
  --room "$ROOM_ID" \
  --iface "$IFACE"
