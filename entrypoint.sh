#!/usr/bin/env bash
set -euo pipefail

CODEX_WORKDIR="${CODEX_WORKDIR:-/home/codex/workspace}"

mkdir -p /home/codex/.ssh "$CODEX_WORKDIR" /home/codex/.codex /var/run/sshd
chown codex:codex /home/codex
chown -R codex:codex /home/codex/.ssh "$CODEX_WORKDIR" /home/codex/.codex
chmod 700 /home/codex/.ssh

if [ -f /home/codex/.ssh/authorized_keys ]; then
  chown codex:codex /home/codex/.ssh/authorized_keys
  chmod 600 /home/codex/.ssh/authorized_keys
fi

if [ "${CHAT_BRIDGE_ENABLE:-false}" = "true" ]; then
  # Generate a secure random token for internal app-server communication
  APP_SERVER_TOKEN_FILE="/home/codex/.codex/app-server-token"
  mkdir -p "$(dirname "$APP_SERVER_TOKEN_FILE")"
  if [ ! -f "$APP_SERVER_TOKEN_FILE" ]; then
    head -c 32 /dev/urandom | base64 > "$APP_SERVER_TOKEN_FILE"
    chown codex:codex "$APP_SERVER_TOKEN_FILE"
    chmod 600 "$APP_SERVER_TOKEN_FILE"
  fi

  # Keep codex app-server under supervision.
  # If it crashes, restart it to avoid container "healthy" but WS backend down.
  runuser -u codex -- env CODEX_WORKDIR="$CODEX_WORKDIR" bash -lc '
    cd "$CODEX_WORKDIR"
    while true; do
      codex app-server --listen ws://127.0.0.1:9090 \
        --ws-auth capability-token --ws-token-file "'"$APP_SERVER_TOKEN_FILE"'" \
        -c sandbox="workspace-write"
      rc=$?
      echo "[entrypoint] codex app-server exited rc=${rc}, restarting in 2s..." >&2
      sleep 2
    done
  ' &

  NP=$(npm root -g)
  runuser -u codex -- env NODE_PATH="$NP" CODEX_WORKDIR="$CODEX_WORKDIR" bash -lc 'cd "$CODEX_WORKDIR" && exec node /home/codex/chat_bridge.js' &
fi

# Start GgySSH Web Terminal
cd /home/codex/ggyssh && runuser -u codex -- ./ggyssh &

exec "$@"
