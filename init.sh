#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

usage() {
  cat <<'EOF'
Usage:
  ./init.sh [start|rebuild|stop|help]

Commands:
  start    Start container (default)
  rebuild  Rebuild image then start container
  stop     Stop container
  help     Show this help
EOF
}

prepare_env() {
  mkdir -p workspace codex ssh
  touch ssh/authorized_keys
  chmod 700 ssh
  chmod 600 ssh/authorized_keys

  export HOST_UID="${HOST_UID:-$(id -u)}"
  export HOST_GID="${HOST_GID:-$(id -g)}"
  echo "Using HOST_UID=${HOST_UID}, HOST_GID=${HOST_GID}"
}

cmd="${1:-start}"

case "${cmd}" in
  start)
    prepare_env
    docker compose up -d
    echo "Done. SSH: ssh -p 2222 codex@<host-ip>"
    ;;
  rebuild)
    prepare_env
    docker compose up -d --build
    echo "Rebuilt and started. SSH: ssh -p 2222 codex@<host-ip>"
    ;;
  stop)
    docker compose down
    echo "Stopped."
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: ${cmd}" >&2
    usage
    exit 1
    ;;
esac
