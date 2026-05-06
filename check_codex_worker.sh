#!/usr/bin/env bash
set -u

SERVICE="codex-worker"
HEALTH_URL="http://127.0.0.1:8090/healthz"
PASS=0
FAIL=0

ok()   { echo "[PASS] $*"; PASS=$((PASS+1)); }
bad()  { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }
info() { echo "[INFO] $*"; }

run_check() {
  local name="$1"
  shift
  if "$@"; then
    ok "$name"
  else
    bad "$name"
  fi
}

echo "=== codex_worker 安裝驗收檢查 ==="

run_check "docker 可用" sh -lc "command -v docker >/dev/null 2>&1"
run_check "docker compose 可用" sh -lc "docker compose version >/dev/null 2>&1"
run_check "docker-compose.yml 存在" test -f docker-compose.yml

CID="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
if [ -n "$CID" ]; then
  ok "找到服務容器: $SERVICE ($CID)"
else
  bad "找不到服務容器: $SERVICE（請先 docker compose up -d --build）"
fi

if [ -n "$CID" ]; then
  STATUS="$(docker inspect -f '{{.State.Status}}' "$CID" 2>/dev/null || echo unknown)"
  RESTARTS="$(docker inspect -f '{{.RestartCount}}' "$CID" 2>/dev/null || echo unknown)"
  info "容器狀態: $STATUS, 重啟次數: $RESTARTS"
  [ "$STATUS" = "running" ] && ok "容器狀態為 running" || bad "容器狀態非 running"
fi

check_file() {
  local path="$1"
  if docker compose exec -T "$SERVICE" sh -lc "[ -f '$path' ]"; then
    ok "容器內檔案存在: $path"
  else
    bad "容器內檔案不存在: $path"
  fi
}

check_file "/home/codex/chat_bridge.js"
check_file "/home/codex/memory_store.js"
check_file "/home/codex/scheduler_store.js"
check_file "/home/codex/.screenrc"

PORT_LINE="$(docker compose port "$SERVICE" 8090 2>/dev/null || true)"
if [ -n "$PORT_LINE" ]; then
  ok "8090 對外映射: $PORT_LINE"
else
  bad "找不到 8090 對外映射"
fi

if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  ok "主機健康檢查通過: $HEALTH_URL"
else
  bad "主機健康檢查失敗: $HEALTH_URL"
fi

if docker compose exec -T "$SERVICE" sh -lc 'curl -fsS --max-time 5 http://127.0.0.1:8090/healthz >/dev/null'; then
  ok "容器內健康檢查通過"
else
  bad "容器內健康檢查失敗"
fi

check_cmd() {
  local cmd="$1"
  if docker compose exec -T "$SERVICE" sh -lc "$cmd >/dev/null 2>&1"; then
    ok "容器內指令可用: $cmd"
  else
    bad "容器內指令不可用: $cmd"
  fi
}

check_cmd "node -v"
check_cmd "npm -v"
check_cmd "codex --version"
check_cmd "bwrap --version"
check_cmd "bubblewrap --version"

echo
echo "=== 檢查摘要 ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "=== 最近 120 行 log（$SERVICE）==="
  docker compose logs --tail=120 "$SERVICE" || true
  exit 1
fi

echo "全部檢查通過。"
