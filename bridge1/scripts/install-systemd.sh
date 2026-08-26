#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="rfid-bridge"
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
SERVICE_USER="${SUDO_USER:-$(id -un)}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

cat >"${UNIT_PATH}" <<EOF
[Unit]
Description=Nexus Receiving RFID bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${BRIDGE_DIR}
ExecStart=${NODE_BIN} src/server.js
Restart=always
RestartSec=5
StartLimitIntervalSec=0
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

mkdir -p "${BRIDGE_DIR}/data"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${BRIDGE_DIR}/data"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
sleep 2
systemctl --no-pager --full status "${SERVICE_NAME}.service"
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3001/status >/dev/null
echo "${SERVICE_NAME} is enabled at boot, running, and /status is healthy."
