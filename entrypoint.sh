#!/usr/bin/env bash
set -euo pipefail

mkdir -p /home/codex/.ssh /home/codex/workspace /var/run/sshd
chown -R codex:codex /home/codex
chmod 700 /home/codex/.ssh

if [ -f /home/codex/.ssh/authorized_keys ]; then
  chown codex:codex /home/codex/.ssh/authorized_keys
  chmod 600 /home/codex/.ssh/authorized_keys
fi

if [ "${CHAT_BRIDGE_ENABLE:-false}" = "true" ]; then
  runuser -u codex -- node /home/codex/chat_bridge.js &
fi

# Start GgySSH Web Terminal
cd /home/codex/ggyssh && runuser -u codex -- ./ggyssh &

exec "$@"
