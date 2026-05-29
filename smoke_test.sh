#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

SERVICE="${SERVICE:-codex-worker}"
TARGET_HOST="${TARGET_HOST:-127.0.0.1}"
PARALLEL_REQUESTS="${PARALLEL_REQUESTS:-12}"
TOTAL_REQUESTS="${TOTAL_REQUESTS:-24}"
TEST_CHANNEL_ID="${TEST_CHANNEL_ID:-99100}"
TEST_USERNAME="${TEST_USERNAME:-smoke_tester}"
ACK_MAX_SECONDS="${ACK_MAX_SECONDS:-3}"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  source .env
fi

CHAT_BRIDGE_PORT="${CHAT_BRIDGE_PORT:-8090}"
CHAT_BRIDGE_PATH="${CHAT_BRIDGE_PATH:-/synology/chat/outgoing}"
SYNCHAT_OUTGOING_TOKEN="${SYNCHAT_OUTGOING_TOKEN:-}"
ADMIN_AUTH_TOKEN="${ADMIN_AUTH_TOKEN:-}"

BASE_URL="http://${TARGET_HOST}:${CHAT_BRIDGE_PORT}"
OUTGOING_URL="${BASE_URL}${CHAT_BRIDGE_PATH}"
HEALTH_URL="${BASE_URL}/healthz"
METRICS_URL="${BASE_URL}/metrics"
INTERNAL_NOTIFY_URL="${BASE_URL}/internal/notify"

PASS_COUNT=0
FAIL_COUNT=0
HEALTH_RETRY_MAX="${HEALTH_RETRY_MAX:-20}"
HEALTH_RETRY_INTERVAL="${HEALTH_RETRY_INTERVAL:-1}"

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo "[PASS] $*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo "[FAIL] $*" >&2
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少必要指令: $1" >&2
    exit 1
  fi
}

post_payload() {
  local text="$1"
  local payload
  payload=$(printf '{"text":"%s","token":"%s","username":"%s","channel_id":"%s"}' \
    "$text" "$SYNCHAT_OUTGOING_TOKEN" "$TEST_USERNAME" "$TEST_CHANNEL_ID")
  curl -sS -X POST "$OUTGOING_URL" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "payload=${payload}"
}

post_payload_with_timing() {
  local text="$1"
  local body_file="$2"
  local payload
  payload=$(printf '{"text":"%s","token":"%s","username":"%s","channel_id":"%s"}' \
    "$text" "$SYNCHAT_OUTGOING_TOKEN" "$TEST_USERNAME" "$TEST_CHANNEL_ID")
  curl -sS -o "$body_file" -w '%{time_total}' -X POST "$OUTGOING_URL" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "payload=${payload}"
}

post_internal_notify_buttons() {
  local payload
  payload=$(printf '{"text":"smoke interactive test","channel_id":"%s","user_id":"","attachments":[{"callback_id":"smoke_buttons","actions":[{"type":"button","name":"approve","text":"同意","value":"approve","style":"green"},{"type":"button","name":"reject","text":"拒絕","value":"reject","style":"red"}]}]}' \
    "$TEST_CHANNEL_ID")
  curl -sS -X POST "$INTERNAL_NOTIFY_URL" \
    -H 'Content-Type: application/json' \
    --data "$payload"
}

get_metrics() {
  if [[ -n "$ADMIN_AUTH_TOKEN" ]]; then
    curl -sS -H "X-Admin-Token: ${ADMIN_AUTH_TOKEN}" "$METRICS_URL"
  else
    curl -sS "$METRICS_URL"
  fi
}

need_cmd curl
need_cmd docker
need_cmd xargs

echo "== codex_worker smoke test =="
echo "ROOT_DIR=${ROOT_DIR}"
echo "OUTGOING_URL=${OUTGOING_URL}"
echo "SERVICE=${SERVICE}"

echo "[STEP] 啟動/重建容器"
if docker compose up -d --build >/dev/null 2>&1; then
  pass "docker compose up -d --build"
else
  fail "docker compose up -d --build"
fi

echo "[STEP] 容器狀態與 crash 前置檢查"
if docker compose ps "$SERVICE" | grep -q "Up"; then
  pass "${SERVICE} 容器狀態為 Up"
else
  fail "${SERVICE} 容器未處於 Up"
fi

recent_logs="$(docker compose logs --tail=120 "$SERVICE" 2>&1 || true)"
if echo "$recent_logs" | grep -Eqi "Cannot find module|SyntaxError|ReferenceError|TypeError:|Error: unable to open database|chat context init fatal|memory init fatal"; then
  fail "偵測到疑似啟動錯誤，請先檢查 docker compose logs --tail=200 ${SERVICE}"
else
  pass "未發現明顯啟動致命錯誤"
fi

echo "[STEP] 健康檢查（含重試）"
health_ok=0
for _ in $(seq 1 "$HEALTH_RETRY_MAX"); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    health_ok=1
    break
  fi
  sleep "$HEALTH_RETRY_INTERVAL"
done

if [[ "$health_ok" -eq 1 ]]; then
  pass "healthz 可連線"
else
  fail "healthz 失敗: ${HEALTH_URL}（已重試 ${HEALTH_RETRY_MAX} 次）"
fi

echo "[STEP] 驗證 internal notify 按鈕路徑"
internal_notify_resp="$(post_internal_notify_buttons || true)"
if [[ "$internal_notify_resp" == *'"ok":true'* ]]; then
  pass "internal notify 按鈕 payload 可送入 bridge"
else
  fail "internal notify 按鈕 payload 異常: ${internal_notify_resp}"
fi

echo "[STEP] 檢查必要 token"
if [[ -n "$SYNCHAT_OUTGOING_TOKEN" ]]; then
  pass "SYNCHAT_OUTGOING_TOKEN 已設定"
else
  fail "SYNCHAT_OUTGOING_TOKEN 未設定（無法測 outgoing）"
fi

if [[ -n "$SYNCHAT_OUTGOING_TOKEN" ]]; then
  echo "[STEP] 送出基本訊息（同 channel）"
  ack_body_file="$(mktemp)"
  ack_time="$(post_payload_with_timing "smoke test 第一輪 $(date +%s)" "$ack_body_file" || true)"
  resp1="$(cat "$ack_body_file" 2>/dev/null || true)"
  rm -f "$ack_body_file"
  resp2="$(post_payload "smoke test 第二輪，請記住第一輪" || true)"

  if [[ "$resp1" == *"已收到"* || "$resp1" == *"text"* ]]; then
    pass "第一輪 outgoing 回應正常"
  else
    fail "第一輪 outgoing 回應異常: ${resp1}"
  fi

  if [[ "$resp2" == *"已收到"* || "$resp2" == *"text"* ]]; then
    pass "第二輪 outgoing 回應正常"
  else
    fail "第二輪 outgoing 回應異常: ${resp2}"
  fi

  if awk "BEGIN { exit !(${ack_time:-999} <= ${ACK_MAX_SECONDS}) }"; then
    pass "第一輪 ACK 時間正常 (${ack_time}s <= ${ACK_MAX_SECONDS}s)"
  else
    fail "第一輪 ACK 過慢 (${ack_time}s > ${ACK_MAX_SECONDS}s)"
  fi
fi

echo "[STEP] 重啟服務後檢查短期上下文 SQLite"
if docker compose restart "$SERVICE" >/dev/null 2>&1; then
  pass "docker compose restart ${SERVICE}"
else
  fail "docker compose restart ${SERVICE}"
fi

sleep 2

if docker compose exec -T "$SERVICE" sh -lc "test -f /home/codex/.codex/chat_context/context.sqlite"; then
  pass "chat_context SQLite 檔案存在"
else
  fail "找不到 /home/codex/.codex/chat_context/context.sqlite"
fi

if docker compose exec -T "$SERVICE" sh -lc "sqlite3 /home/codex/.codex/chat_context/context.sqlite \"select count(*) from channel_context where channel_id='${TEST_CHANNEL_ID}';\" | grep -Eq '^[1-9][0-9]*$'"; then
  pass "指定 channel 的短期上下文已持久化"
else
  fail "指定 channel 的短期上下文未找到（可能尚未完成寫入）"
fi

echo "[STEP] 並發請求與 backpressure 觀察"
if [[ -n "$SYNCHAT_OUTGOING_TOKEN" ]]; then
  seq 1 "$TOTAL_REQUESTS" | xargs -I{} -P "$PARALLEL_REQUESTS" sh -c \
    'curl -sS -X POST "'"$OUTGOING_URL"'" -H "Content-Type: application/x-www-form-urlencoded" --data-urlencode "payload={\"text\":\"smoke burst {}\",\"token\":\"'"$SYNCHAT_OUTGOING_TOKEN"'\",\"username\":\"'"$TEST_USERNAME"'\",\"channel_id\":\"'"$TEST_CHANNEL_ID"'\"}" >/dev/null || true'
  pass "並發請求已送出 (${TOTAL_REQUESTS}, parallel=${PARALLEL_REQUESTS})"
else
  fail "跳過並發測試（缺少 SYNCHAT_OUTGOING_TOKEN）"
fi

echo "[STEP] metrics 檢查"
metrics_raw="$(get_metrics || true)"
if [[ "$metrics_raw" == *"scheduler_enabled"* ]]; then
  pass "/metrics 可讀取"
else
  fail "/metrics 無法讀取或未授權（請確認 ADMIN_AUTH_TOKEN）"
fi

if [[ "$metrics_raw" == *"task_queue"* ]]; then
  pass "metrics 含 task_queue 狀態"
else
  fail "metrics 缺少 task_queue 欄位"
fi

if [[ "$metrics_raw" == *"task_queue_enqueued_total"* ]]; then
  pass "metrics 含 task_queue 計數器"
else
  fail "metrics 缺少 task_queue 計數器"
fi

echo
echo "== 測試摘要 =="
echo "PASS=${PASS_COUNT}"
echo "FAIL=${FAIL_COUNT}"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "RESULT=FAIL"
  exit 1
fi

echo "RESULT=PASS"
