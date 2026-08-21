#!/usr/bin/env bash
set -euo pipefail

SOURCE_ROOT=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
CONFIG_PATH=${2:-/etc/zes-conversation-transport-bridge.json}
INSTALL_ROOT=/usr/local/lib/zes-conversation-transport-bridge
UNIT_PATH=/etc/systemd/system/zes-conversation-transport-bridge.service

if [[ ${EUID} -ne 0 ]]; then
  echo "This installer must run as root." >&2
  exit 1
fi

install -d -m 0755 "${INSTALL_ROOT}"
install -m 0755 \
  "${SOURCE_ROOT}/scripts/zes-conversation-transport-bridge.py" \
  "${INSTALL_ROOT}/bridge.py"
install -m 0755 \
  "${SOURCE_ROOT}/scripts/zes_codex_gateway.py" \
  "${INSTALL_ROOT}/zes_codex_gateway.py"
install -m 0755 \
  "${SOURCE_ROOT}/scripts/zes_codex_app_server_channel.py" \
  "${INSTALL_ROOT}/zes_codex_app_server_channel.py"
install -m 0644 \
  "${SOURCE_ROOT}/examples/systemd/zes-conversation-transport-bridge.service" \
  "${UNIT_PATH}"
install -d -m 0700 /var/lib/zes-conversation-transport-bridge
install -d -m 0750 /run/zes-conversation-transport-bridge

if [[ ! -f ${CONFIG_PATH} ]]; then
  echo "Missing root-owned bridge config: ${CONFIG_PATH}" >&2
  exit 1
fi
chmod 0600 "${CONFIG_PATH}"

/usr/bin/python3 "${INSTALL_ROOT}/bridge.py" \
  --config "${CONFIG_PATH}" validate-config
systemctl daemon-reload
systemctl enable zes-conversation-transport-bridge.service

echo "Bridge installed with effects controlled by ${CONFIG_PATH}."
echo "Start or restart the unit only after the deployment writer gate is held."
