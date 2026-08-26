#!/usr/bin/env bash
set -euo pipefail

# Installs THIS bridge directory as its own systemd service.
#
# The repo holds one directory per physical gate (bridge1/, bridge2/), each with
# its own .env, its own data/, and its own service. Everything below is derived
# from the directory this script lives in, so the same script run from bridge1/
# and from bridge2/ produces two independent units that never collide:
#
#   sudo bridge1/scripts/install-systemd.sh   -> rfid-bridge1, port from bridge1/.env
#   sudo bridge2/scripts/install-systemd.sh   -> rfid-bridge2, port from bridge2/.env
#
# Pass a name to override: sudo bridge2/scripts/install-systemd.sh rfid-gate2

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${1:-rfid-$(basename "${BRIDGE_DIR}")}"
NODE_BIN="$(command -v node)"
SERVICE_USER="${SUDO_USER:-$(id -un)}"
UNIT_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="${BRIDGE_DIR}/.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo $0" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "No .env in ${BRIDGE_DIR} — copy .env.example and set this gate's PORT, GATE_ID, GATE_SHORT, UR4_IP first." >&2
  exit 1
fi

# The bridge's own port, read from the .env it will actually load. dotenv lets a
# later line win, so take the last PORT= assignment, same as the bridge does.
PORT="$(sed -n 's/^[[:space:]]*PORT=\([0-9][0-9]*\).*/\1/p' "${ENV_FILE}" | tail -1)"
PORT="${PORT:-3001}"

# Refuse to hijack another gate's unit. Without this, running the installer from
# the second gate's directory would silently repoint the first gate's service at
# the wrong WorkingDirectory — one reader, two services, one dead gate.
if [[ -f "${UNIT_PATH}" ]]; then
  EXISTING_DIR="$(sed -n 's/^WorkingDirectory=//p' "${UNIT_PATH}" | tail -1)"
  if [[ -n "${EXISTING_DIR}" && "${EXISTING_DIR}" != "${BRIDGE_DIR}" ]]; then
    echo "Refusing to overwrite ${UNIT_PATH}: it already runs ${EXISTING_DIR}, not ${BRIDGE_DIR}." >&2
    echo "That unit belongs to another gate. Pass a distinct service name instead:" >&2
    echo "  sudo $0 rfid-<something-unique>" >&2
    exit 1
  fi
fi

echo "Installing ${SERVICE_NAME}: ${BRIDGE_DIR} on port ${PORT} as ${SERVICE_USER}"

cat >"${UNIT_PATH}" <<EOF
[Unit]
Description=Nexus Receiving RFID bridge (${SERVICE_NAME})
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
curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${PORT}/status" >/dev/null
echo "${SERVICE_NAME} is enabled at boot, running, and /status on ${PORT} is healthy."
