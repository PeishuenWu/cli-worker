# cli_worker

此目錄提供一個基於 Debian 12 的 Docker 環境，包含：
- SSH Server（僅允許金鑰驗證）
- 使用者 `codex`
- Node.js（由 NodeSource 安裝）
- 全域安裝 `@openai/codex`
- `bubblewrap`（提供 `bwrap` 與 `bubblewrap` 指令）
- Synology Chat webhook bridge（可接收訊息、呼叫 codex、回覆聊天室）

## 目錄對應

`docker-compose.yml` 已設定以下掛載：
- `./workspace -> /home/codex/workspace`
- `./ssh -> /home/codex/.ssh`
- `./codex -> /home/codex/.codex`

請將 SSH 公鑰放在：
- `./ssh/authorized_keys`

建議權限：
```bash
chmod 700 ssh
chmod 600 ssh/authorized_keys
```

## 啟動

在 `codex_worker/` 目錄執行：
```bash
docker compose up -d --build
```

若主機掛載目錄會遇到 `Permission denied`，建議先對齊 UID/GID：
```bash
export HOST_UID=$(id -u)
export HOST_GID=$(id -g)
docker compose up -d --build
```

SSH 連線：
```bash
ssh -p 2222 codex@<host-ip>
```

## 版本參數

在 `docker-compose.yml` 的 build args 可控制版本：
- `NODE_MAJOR`：Node.js 主版本（例如 `20`、`22`）
- `CODEX_NPM_VERSION`：`@openai/codex` 版本（例如 `latest`、`0.XX.X`）

預設：
- `NODE_MAJOR=22`
- `CODEX_NPM_VERSION=latest`

## 升級建議流程

1. 鎖定版本（建議正式環境）：
```yaml
args:
  NODE_MAJOR: "22"
  CODEX_NPM_VERSION: "0.XX.X"
```
2. 建置新映像：
```bash
docker compose build --no-cache
```
3. 啟動並驗證：
```bash
docker compose up -d
```
4. 檢查版本：
```bash
docker compose exec codex-worker node -v
docker compose exec codex-worker npm -v
docker compose exec codex-worker codex --version
docker compose exec codex-worker bwrap --version
docker compose exec codex-worker bubblewrap --version
```
5. 確認無誤後再推到正式環境。

## 更新到最新（非鎖版）

若要追最新版本：
1. 將 `CODEX_NPM_VERSION` 設為 `latest`
2. 重新 build：
```bash
docker compose build --no-cache
docker compose up -d
```

## Synology Chat 整合（Outgoing + Incoming）

容器預設會啟動 webhook bridge：
- 監聽埠：`8090`
- 路徑：`/synology/chat/outgoing`
- 健康檢查：`GET /healthz`

### 1) 設定 `.env`

請編輯 `codex_worker/.env`（可先用 `.env.example` 複製）：
```bash
cp .env.example .env
```

填入：
```dotenv
SYNCHAT_OUTGOING_TOKEN=你的_outgoing_token
SYNCHAT_INCOMING_URL=https://<nas>/webapi/entry.cgi?api=SYNO.Chat.External&method=incoming&version=2&token=...
OPENAI_API_KEY=<你的_openai_api_key>
ADMIN_AUTH_TOKEN=設定一個強密碼以保護管理介面
TZ=Asia/Taipei
```

`CODEX_MODEL` 若要調整，仍可用 shell 環境變數覆蓋，例如：
```bash
export CODEX_MODEL='gpt-5.4-mini'
```

若 `OPENAI_API_KEY` 未設定，系統會自動退回 JSON 關鍵字記憶（非向量檢索）。

若未設定 `SYNCHAT_INCOMING_URL`，bridge 會嘗試同步回傳結果（較容易遇到 webhook timeout）；有設定時會先回 `已收到`，再非同步推送完整回答。

### 2) Synology Chat 端設定建議

1. 於 Chat Integration 建立 `Incoming Webhook`，複製 URL，填入 `SYNCHAT_INCOMING_URL`。
2. 建立 `Outgoing Webhook` 或 Slash Command，URL 指向：
   - `http://<你的主機IP>:8090/synology/chat/outgoing`
3. 將 outgoing 設定中的 token 與 `SYNCHAT_OUTGOING_TOKEN` 對齊。
4. 重新啟動容器：
```bash
docker compose up -d --build
```

### 3) 本機測試（模擬 outgoing）

```bash
curl -sS -X POST 'http://127.0.0.1:8090/synology/chat/outgoing' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'payload={\"text\":\"@codex 幫我列出今天待辦\",\"token\":\"'$SYNCHAT_OUTGOING_TOKEN'\",\"username\":\"tester\",\"channel_name\":\"dev\"}'
```

預期先收到：
```json
{"text":"已收到，Codex 產生回覆中。"}
```

接著 bridge 會把 codex 輸出推送到 `SYNCHAT_INCOMING_URL`。

### 3.1) 一鍵 Smoke Test（建議部署後執行）

在 `codex_worker/` 目錄：
```bash
./smoke_test.sh
```

可選參數（環境變數）：
```bash
TARGET_HOST=192.168.30.163 PARALLEL_REQUESTS=12 TOTAL_REQUESTS=24 ./smoke_test.sh
```

說明：
- 會自動執行 `docker compose up -d --build`、`/healthz`、`/metrics` 檢查。
- 會送出 outgoing webhook 測試訊息（需 `.env` 有 `SYNCHAT_OUTGOING_TOKEN`）。
- 會重啟 `codex-worker` 後檢查短期上下文 SQLite 是否仍存在（持久化驗證）。
- 會做並發請求，觀察 task queue/backpressure 指標。

### 4) 常用參數

- `CHAT_BRIDGE_ENABLE`：`true/false`，是否啟動 bridge。
- `CHAT_BRIDGE_PORT`：bridge 監聽埠。
- `CHAT_BRIDGE_PATH`：webhook 路徑。
- `CODEX_WORKDIR`：`codex exec -C` 目錄。
- `CODEX_TIMEOUT_MS`：單次呼叫逾時（毫秒）。
- `CODEX_SANDBOX_MODE`：`codex exec --sandbox` 模式（例如 `workspace-write`、`danger-full-access`）。
- `CODEX_BYPASS_SANDBOX`：`true` 時加入 `--dangerously-bypass-approvals-and-sandbox`（高風險，僅建議內網隔離環境）。
- `MAX_REPLY_CHARS`：回覆長度上限。
- `CODEX_SYSTEM_PROMPT`：注入到每次任務前的系統提示。
- `VISION_MODEL`：視覺分析模型名稱（預設 `qwen2-vl`）。
- `OLLAMA_API_URL`：Ollama API 伺服器位址（預設 `http://127.0.0.1:11434`）。
- `MEMORY_ENABLE`：是否啟用記憶系統。
- `QDRANT_URL`、`QDRANT_COLLECTION`：向量資料庫位置與集合名稱。
- `EMBEDDING_MODEL`、`EMBEDDING_DIM`：向量模型與維度。
- `MEMORY_TOP_K`、`MEMORY_SCORE_THRESHOLD`：檢索數量與相似度門檻。
- `MEMORY_SHORT_TTL_DAYS`：短期記憶過期天數。
- `CHAT_CONTEXT_ENABLE`：是否啟用短期對話 SQLite 持久化。
- `CHAT_CONTEXT_DB_PATH`：短期對話 SQLite 路徑（預設 `/home/codex/.codex/chat_context/context.sqlite`）。
- `CHAT_CONTEXT_MAX_MESSAGES`：每個頻道保留的短期訊息數（預設 10）。
- `TASK_CONCURRENCY`：背景任務並行數（預設 2）。
- `TASK_QUEUE_MAX`：背景任務佇列上限，超過會觸發 backpressure（預設 200）。

### 5) 記憶系統運作

- `qdrant` 服務會隨 compose 一起啟動（預設 `6333`）。
- 每次收到 Chat 訊息：
  1. 先向向量庫檢索相關記憶並注入 prompt（預設會依 `project + channel + username + source` 過濾）。
  2. 產生回覆後，將本次問答寫入短期記憶（含 TTL）。
- 若向量服務或 embedding 不可用，會自動退回 `MEMORY_FALLBACK_FILE` 關鍵字記憶。
- 短期對話上下文使用 SQLite 持久化，容器重啟後仍可保留最近對話。

### 6) 排程執行功能（SQLite）

- 排程資料使用 SQLite，預設路徑：`/home/codex/.codex/scheduler/jobs.sqlite`
- 支援指令（由 Chat 訊息觸發）：
  1. `schedule at YYYY-MM-DD HH:MM <任務內容>`
  2. `schedule cron <m h dom mon dow> <任務內容>`
  3. `schedule list`
  4. `schedule pause <job_id>`
  5. `schedule resume <job_id>`
  6. `schedule cancel <job_id>`
- 例子：
```text
@codex schedule at 2026-04-17 09:00 幫我整理今日重點
@codex schedule cron 0 9 * * 1-5 幫我整理平日晨會摘要
@codex schedule list
@codex schedule pause 3
@codex schedule resume 3
@codex schedule cancel 3
```

排程到點後會：
1. 自動觸發 `codex exec`
2. 將結果推送到 `SYNCHAT_INCOMING_URL`
3. 以既有 memory 流程寫入記憶
4. 失敗時依 backoff 重試，超過上限才標記 `failed`
5. 排程結果會寫入長期記憶，並自動附上標籤（例如 `scheduler`, `job:<id>`, `type:cron`）與 job metadata

監控：
- `GET /metrics` 可查看排程執行統計與任務佇列狀態（queue length/running/concurrency/max）

排程相關 `.env` 參數：
- `SCHEDULER_ENABLE`：是否啟用排程
- `SCHEDULER_DB_PATH`：SQLite 檔案路徑
- `SCHEDULER_TICK_SECONDS`：輪詢週期（秒）
- `SCHEDULER_CLAIM_LIMIT`：每輪最多取出的待執行工作數
- `SCHEDULER_MAX_RETRIES`：單一任務最大重試次數
- `SCHEDULER_RETRY_BASE_SECONDS`：重試基礎秒數（指數退避）
- `TZ`：容器系統時區（`schedule at` 會依此解析輸入時間）
- `SCHEDULER_DEFAULT_TIMEZONE`：排程提示訊息用時區（預設跟 `TZ` 一致）
- `SCHEDULER_ALLOWED_USERS`：允許使用排程的使用者（逗號分隔，空值表示不限制）
- `SCHEDULER_ALLOWED_CHANNELS`：允許使用排程的頻道（逗號分隔，空值表示不限制）
- `SCHEDULER_ADMIN_USERS`：排程管理者（可查看全部、管理他人排程）
- `SCHEDULER_MAX_ACTIVE_PER_USER`：每位使用者可擁有的進行中排程上限
- `SCHEDULER_MAX_ACTIVE_PER_CHANNEL`：每個頻道可擁有的進行中排程上限
- `SCHEDULER_RETENTION_DAYS`：`done/canceled/failed` 保留天數
- `SCHEDULER_CLEANUP_SECONDS`：清理週期（秒）

### 7) 管理介面（內網無登入 / HTMX）

- 入口：`GET /admin`（可由 `ADMIN_UI_PATH` 變更）
- 特色：內網快速管理、HTMX 定時刷新（建議啟用 token 保護）
- 內容：
  1. Dashboard（排程指標與狀態統計）
  2. Schedules（最近排程含各狀態）
  3. Memories（最近記憶摘要/標籤）

管理介面 `.env` 參數：
- `ADMIN_UI_ENABLE`：是否啟用管理介面
- `ADMIN_UI_PATH`：管理介面路徑（預設 `/admin`）
- `ADMIN_AUTH_TOKEN`：管理介面與 `/metrics` 的存取 token（建議必填）
- `ADMIN_UI_MEMORY_LIMIT`：記憶列表筆數
- `ADMIN_UI_SCHEDULE_LIMIT`：排程列表筆數

存取方式（擇一）：
- Query：`GET /admin?token=<ADMIN_AUTH_TOKEN>`（首次帶 token 會寫入 HttpOnly cookie）
- Header：`Authorization: Bearer <ADMIN_AUTH_TOKEN>` 或 `X-Admin-Token: <ADMIN_AUTH_TOKEN>`

注意：若 `ADMIN_AUTH_TOKEN` 為空值，管理介面仍可直接存取；正式環境請務必設定並搭配網路層 ACL/反向代理限制來源。

## 安全設定摘要

容器內 SSH 設定已套用：
- `PermitRootLogin no`
- `PasswordAuthentication no`
- `PubkeyAuthentication yes`
- `AllowUsers codex`

因此僅能使用 `codex` 帳號搭配金鑰登入。
