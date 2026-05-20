'use strict';

const fs = require('fs');
const path = require('path');
const { 
  ADMIN_AUTH_TOKEN, DOWNLOADS_DIR, ADMIN_UI_PATH, SCHEDULER_ENABLE, 
  MEMORY_PROJECT, ADMIN_UI_MEMORY_LIMIT, ADMIN_UI_SCHEDULE_LIMIT 
} = require('../config');
const { metrics } = require('../logger');
const { schedulerStore, memoryStore } = require('../stores');
const { parseCookies, escapeHtml, shortText, fmtTs } = require('../utils');

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch (_e) {
    return fallback;
  }
}

function getAdminTokenFromRequest(req, urlObj) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const xToken = String(req.headers['x-admin-token'] || '').trim();
  if (xToken) return xToken;
  const queryToken = String(urlObj.searchParams.get('token') || '').trim();
  if (queryToken) return queryToken;
  const cookies = parseCookies(req.headers.cookie);
  return String(cookies.admin_token || '').trim();
}

function isAdminAuthorized(req, urlObj) {
  if (!ADMIN_AUTH_TOKEN) return true;
  const token = getAdminTokenFromRequest(req, urlObj);
  return token && token === ADMIN_AUTH_TOKEN;
}

function setAdminAuthCookieIfNeeded(req, res, urlObj) {
  if (!ADMIN_AUTH_TOKEN) return;
  const queryToken = String(urlObj.searchParams.get('token') || '').trim();
  if (!queryToken || queryToken !== ADMIN_AUTH_TOKEN) return;
  res.setHeader('Set-Cookie', 'admin_token=' + encodeURIComponent(queryToken) + '; Path=/; HttpOnly; SameSite=Strict');
}

async function serveStaticFile(req, res, filename) {
  const safeName = path.basename(filename);
  const filePath = path.join(DOWNLOADS_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file_not_found' }));
    return;
  }

  const stat = fs.statSync(filePath);
  const ext = path.extname(safeName).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.json': 'application/json',
  };

  res.writeHead(200, {
    'Content-Type': mimeMap[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
}

function renderAdminPage() {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Worker 管理介面</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css" />
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <script src="https://unpkg.com/htmx.org@1.9.12/dist/ext/sse.js"></script>
  <style>
    :root { --pico-font-size: 14px; }
    body { padding-top: 1rem; }
    .muted { color: var(--pico-muted-color); font-size: 0.85rem; }
    code { font-size: 0.8rem; }
    table { --pico-font-size: 13px; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .card-header h2 { margin-bottom: 0; font-size: 1.25rem; }
    .status-badge { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; text-transform: uppercase; font-weight: bold; }
    .status-done { background: #d4edda; color: #155724; }
    .status-pending { background: #fff3cd; color: #856404; }
    .status-failed { background: #f8d7da; color: #721c24; }
    
    nav[role="tablist"] { margin-bottom: 2rem; border-bottom: 1px solid var(--pico-muted-border-color); }
    nav[role="tablist"] button { 
      background: transparent; border: none; border-bottom: 3px solid transparent; 
      border-radius: 0; color: var(--pico-muted-color); margin-bottom: -1px;
    }
    nav[role="tablist"] button.active { 
      color: var(--pico-primary); border-bottom-color: var(--pico-primary); 
    }
  </style>
</head>
<body hx-boost="true">
  <main class="container">
    <header>
      <hgroup>
        <h1>Codex Worker 管理介面</h1>
        <p>內網模式 | Started: ${escapeHtml(metrics.started_at)}</p>
      </hgroup>
    </header>

    <nav role="tablist">
      <ul>
        <li>
          <button class="active" 
            hx-get="${ADMIN_UI_PATH}/partials/dashboard" 
            hx-target="#tab-content"
            onclick="switchTab(this)">
            系統總覽
          </button>
        </li>
        <li>
          <button 
            hx-get="${ADMIN_UI_PATH}/partials/schedules" 
            hx-target="#tab-content"
            onclick="switchTab(this)">
            排程管理
          </button>
        </li>
        <li>
          <button 
            hx-get="${ADMIN_UI_PATH}/partials/contexts" 
            hx-target="#tab-content"
            onclick="switchTab(this)">
            對話執行緒 (Threads)
          </button>
        </li>
        <li>
          <button 
            hx-get="${ADMIN_UI_PATH}/partials/memories" 
            hx-target="#tab-content"
            onclick="switchTab(this)">
            記憶列表
          </button>
        </li>
        <li>
          <button 
            hx-get="${ADMIN_UI_PATH}/partials/events" 
            hx-target="#tab-content"
            onclick="switchTab(this)">
            實時動態 (SSE)
          </button>
        </li>
        <li>
          <button 
            hx-get="${ADMIN_UI_PATH}/partials/chat" 
            hx-target="#tab-content"
            onclick="switchTab(this)">
            對話測試 (Chat)
          </button>
        </li>
      </ul>
    </nav>

    <div id="tab-content" hx-get="${ADMIN_UI_PATH}/partials/dashboard" hx-trigger="load">
      <p aria-busy="true">載入中...</p>
    </div>

  </main>

  <script>
    function switchTab(el) {
      document.querySelectorAll('nav[role="tablist"] button').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    }
  </script>
</body>
</html>`;
}


async function renderDashboardPartial() {
  const statusCounts = await schedulerStore.getStatusCounts().catch(() => ({}));
  const stats = [
    { label: 'Ticks', value: metrics.scheduler_ticks_total },
    { label: 'Claimed', value: metrics.scheduler_jobs_claimed_total },
    { label: 'Success', value: metrics.scheduler_jobs_success_total },
    { label: 'Retry', value: metrics.scheduler_jobs_retry_total },
    { label: 'Failed', value: metrics.scheduler_jobs_failed_total },
  ];

  const statusTags = Object.entries(statusCounts).map(([k, v]) => 
    `<mark>${escapeHtml(k)}: ${v}</mark>`
  ).join(' ');

  return `
<div class="card-header">
  <h2>系統總覽</h2>
  <div>${statusTags}</div>
</div>
<div class="grid">
  ${stats.map(s => `
    <div style="text-align: center; border: 1px solid var(--pico-muted-border-color); padding: 0.5rem; border-radius: 8px;">
      <div class="muted">${escapeHtml(s.label)}</div>
      <div style="font-size: 1.5rem; font-weight: bold;">${escapeHtml(String(s.value))}</div>
    </div>
  `).join('')}
</div>
<hr>
<table class="striped">
  <thead><tr><th>維護指標</th><th>數值</th></tr></thead>
  <tbody>
    <tr><td>Cleanup Deleted</td><td>${escapeHtml(String(metrics.scheduler_cleanup_deleted_total))}</td></tr>
    <tr><td>Cmd Denied</td><td>${escapeHtml(String(metrics.schedule_commands_denied_total))}</td></tr>
    <tr><td>Scheduler Status</td><td>${String(SCHEDULER_ENABLE) === 'true' ? '🟢 Active' : '🔴 Disabled'}</td></tr>
  </tbody>
</table>`;
}

async function renderSchedulesPartial(urlObj) {
  const statusFilter = urlObj ? urlObj.searchParams.get('status') : 'active';
  const rowsAll = await schedulerStore.listJobsAll(ADMIN_UI_SCHEDULE_LIMIT).catch(() => []);

  const rows = statusFilter && statusFilter !== 'all' 
    ? rowsAll.filter(r => r.status === statusFilter)
    : rowsAll;

  const statuses = ['active', 'running', 'done', 'failed', 'paused', 'canceled'];

  return `
<div class="card-header">
  <h2>排程列表</h2>
  <div style="display: flex; gap: 8px; align-items: center;">
    <span class="muted">篩選狀態:</span>
    <select name="status" 
      hx-get="${ADMIN_UI_PATH}/partials/schedules" 
      hx-target="#tab-content" 
      style="margin: 0; padding: 4px 8px; width: auto; font-size: 13px;">
      <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>全部</option>
      ${statuses.map(s => `<option value="${s}" ${statusFilter === s ? 'selected' : ''}>${s}</option>`).join('')}
    </select>
    <span class="muted">共 ${rows.length} 筆</span>
  </div>
</div>
<div class="overflow-auto">
  <table class="striped">
    <thead>
      <tr>
        <th>ID</th>
        <th>狀態</th>
        <th>類型/Cron</th>
        <th>執行時間</th>
        <th>對象/頻道</th>
        <th>任務內容</th>
        <th>重試</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((row) => {
        const statusClass = row.status === 'done' ? 'status-done' : (row.status === 'pending' || row.status === 'active' ? 'status-pending' : 'status-failed');
        const canCancel = ['active', 'running', 'paused', 'failed'].includes(row.status);
        return `
          <tr>
            <td>${escapeHtml(String(row.id || ''))}</td>
            <td><span class="status-badge ${statusClass}">${escapeHtml(String(row.status || ''))}</span></td>
            <td>
              <strong>${escapeHtml(String(row.type || ''))}</strong>
              ${row.cron_expr ? `<br><code>${escapeHtml(String(row.cron_expr))}</code>` : ''}
            </td>
            <td>${escapeHtml(fmtTs(row.run_at))}</td>
            <td>
              ${escapeHtml(String(row.username || '-'))}<br>
              <small class="muted">${escapeHtml(String(row.channel || '-'))}</small>
            </td>
            <td title="${escapeHtml(String(row.prompt || ''))}">${escapeHtml(shortText(row.prompt, 60))}</td>
            <td>${escapeHtml(String(row.retry_count || 0))}/${escapeHtml(String(row.max_retries || 0))}</td>
            <td>
              ${canCancel ? `
                <button 
                  class="outline secondary" 
                  style="padding: 2px 8px; font-size: 11px; margin: 0;"
                  hx-post="${ADMIN_UI_PATH}/schedules/${row.id}/cancel"
                  hx-target="#tab-content"
                  hx-confirm="確定要取消排程 #${row.id} 嗎？">
                  取消
                </button>
              ` : '-'}
            </td>
          </tr>
        `;
      }).join('')}
    </tbody>
  </table>
</div>`;
}

async function renderMemoriesPartial(urlObj) {
  const search = urlObj ? urlObj.searchParams.get('search') : '';
  const rows = await memoryStore.listRecent({
    project: MEMORY_PROJECT,
    limit: ADMIN_UI_MEMORY_LIMIT,
    search: search
  }).catch(() => []);

  return `
<div class="card-header">
  <h2>記憶列表</h2>
  <div style="display: flex; gap: 8px; align-items: center;">
    <input type="search" name="search" value="${escapeHtml(search)}" 
      placeholder="搜尋摘要或標籤..."
      hx-get="${ADMIN_UI_PATH}/partials/memories"
      hx-trigger="keyup changed delay:500ms, search"
      hx-target="#tab-content"
      style="margin: 0; padding: 4px 8px; width: 250px; font-size: 13px;" />
    <span class="muted">project=${escapeHtml(MEMORY_PROJECT)}</span>
  </div>
</div>
<div class="overflow-auto">
  <table class="striped">
    <thead>
      <tr>
        <th>ID</th>
        <th>Scope/來源</th>
        <th>使用者</th>
        <th>時間</th>
        <th>標籤</th>
        <th>摘要</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((row) => `
        <tr>
          <td>${escapeHtml(String(row.id || ''))}</td>
          <td>
            <ins>${escapeHtml(String(row.scope || ''))}</ins><br>
            <small class="muted">${escapeHtml(String(row.source || '-'))}</small>
          </td>
          <td>${escapeHtml(String(row.username || '-'))}</td>
          <td>${escapeHtml(fmtTs(row.created_at))}</td>
          <td>${(Array.isArray(row.tags) ? row.tags : []).map(t => `<kbd>${escapeHtml(t)}</kbd>`).join(' ')}</td>
          <td title="${escapeHtml(String(row.summary || ''))}">${escapeHtml(shortText(row.summary, 80))}</td>
          <td>
            <div style="display: flex; gap: 4px;">
              ${row.scope === 'short' ? `
                <button class="outline" style="padding: 2px 6px; font-size: 10px; margin: 0;"
                  hx-post="${ADMIN_UI_PATH}/memories/${row.id}/promote"
                  hx-target="#tab-content"
                  hx-confirm="確定要將此記憶轉為長期記憶嗎？">
                  晉升
                </button>
              ` : ''}
              <button class="outline secondary" style="padding: 2px 6px; font-size: 10px; margin: 0;"
                hx-delete="${ADMIN_UI_PATH}/memories/${row.id}"
                hx-target="#tab-content"
                hx-confirm="確定要刪除此筆記憶嗎？">
                刪除
              </button>
            </div>
          </td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</div>`;
}

async function renderContextsPartial() {
  const { chatContextStore } = require('../stores');
  const rows = await chatContextStore.listRecentChannels().catch(() => []);

  return `
<div class="card-header">
  <h2>對話執行緒 (Threads)</h2>
  <span class="muted">顯示最近活動的 ${rows.length} 個執行緒</span>
</div>
<div class="overflow-auto">
  <table class="striped">
    <thead>
      <tr>
        <th>執行緒 ID (Channel)</th>
        <th>最後更新</th>
        <th>對話回合 (Turns) 摘要</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      ${rows.map((row) => {
        const history = safeJsonParse(row.history_json, []);
        const summary = history.map(h => `${h.role === 'user' ? 'U' : 'A'}: ${shortText(h.text, 30)}`).join('<br>');
        return `
          <tr>
            <td><code>${escapeHtml(row.channel_id)}</code></td>
            <td>${escapeHtml(fmtTs(row.updated_at))}</td>
            <td style="font-size: 11px; line-height: 1.2;">${summary}</td>
            <td>
              <button class="outline secondary" style="padding: 2px 8px; font-size: 11px; margin: 0;"
                hx-delete="${ADMIN_UI_PATH}/contexts/${row.channel_id}"
                hx-target="#tab-content"
                hx-confirm="確定要清除執行緒 ${row.channel_id} 的所有對話背景嗎？這會讓機器人忘記之前的對話。">
                清除執行緒
              </button>
            </td>
          </tr>
        `;
      }).join('')}
    </tbody>
  </table>
</div>`;
}

async function renderEventsPartial() {
  return `
<div class="card-header">
  <h2>實時動態 (SSE Activity)</h2>
  <span class="muted">根據 OpenAI App-Server 模型實現的實時監控</span>
</div>
<div hx-ext="sse" sse-connect="${ADMIN_UI_PATH}/events">
  <div id="log-stream" style="background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 8px; font-family: 'Cascadia Code', 'Fira Code', monospace; height: 600px; overflow-y: auto; font-size: 12px; line-height: 1.5; border: 1px solid #333; box-shadow: inset 0 0 10px rgba(0,0,0,0.5);">
    <div style="color: #6a9955; border-bottom: 1px dashed #444; margin-bottom: 8px; padding-bottom: 4px;">[System] SSE 連線已建立，等待事件中...</div>
  </div>
</div>
<script>
  // Clean up existing listeners if any (though HTMX partials might re-run this)
  if (window._logListener) {
    document.body.removeEventListener('htmx:sseMessage', window._logListener);
  }

  window._logListener = function(e) {
    // htmx:sseMessage is fired for any event. Check e.detail.type
    if (e.detail.type === 'log') {
      try {
        const data = JSON.parse(e.detail.data);
        const logStream = document.getElementById('log-stream');
        if (!logStream) return;

        const div = document.createElement('div');
        div.style.marginBottom = '2px';
        div.style.whiteSpace = 'pre-wrap';
        div.style.wordBreak = 'break-all';
        
        const timestamp = new Date(data.timestamp).toLocaleTimeString();
        const color = data.level === 'error' ? '#f44336' : (data.level === 'warn' ? '#ff9800' : '#d4d4d4');
        const levelBadge = \`<span style="color: \${color}; font-weight: bold; min-width: 50px; display: inline-block;">\${data.level.toUpperCase()}</span>\`;
        const rid = data.requestId ? \`<span style="color: #569cd6;"> [\${data.requestId}]</span>\` : '';
        
        div.innerHTML = \`<span style="color: #808080;">[\${timestamp}]</span> \${levelBadge}\${rid} \${escapeHtml(data.message)}\`;
        
        logStream.insertBefore(div, logStream.firstChild);
        
        // Auto-cleanup: keep last 200 lines
        if (logStream.children.length > 200) {
          logStream.removeChild(logStream.lastChild);
        }
      } catch (err) {
        console.error('Failed to parse SSE log data', err);
      }
    }
  };

  document.body.addEventListener('htmx:sseMessage', window._logListener);

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
</script>
`;
}

async function renderChatPartial() {
  return `
<div class="card-header">
  <h2>對話測試 (Codex Chat)</h2>
  <span class="muted">基於 codex app-server 的原生對話體驗</span>
</div>

<div id="chat-container" style="display: flex; flex-direction: column; height: calc(100vh - 350px); background: #111; border-radius: 8px; border: 1px solid #333; overflow: hidden;">
  <div id="chat-messages" style="flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem;">
    <div style="text-align: center; color: #666; font-size: 0.9rem; margin-top: 2rem;">
      <p>歡迎來到 Codex Chat！這裡可以直接與後端的 app-server 溝通。</p>
      <p>訊息會即時透過 WebSocket 串流傳輸。</p>
    </div>
  </div>
  
  <div id="chat-input-area" style="padding: 1rem; background: #1a1a1a; border-top: 1px solid #333;">
    <div style="display: flex; gap: 0.5rem; align-items: flex-end;">
      <textarea id="chat-input" placeholder="輸入訊息... (Shift+Enter 換行, Enter 送出)" rows="1" 
        style="margin: 0; background: #222; border-color: #444; color: #eee; resize: none; overflow-y: hidden; min-height: 44px;"></textarea>
      <button id="chat-send-btn" style="width: auto; margin: 0; padding: 0.5rem 1rem; height: 44px;">送出</button>
    </div>
    <div id="chat-status" class="muted" style="margin-top: 0.5rem; font-size: 0.75rem;">
      連線狀態: <span id="ws-status">正在連線...</span>
    </div>
  </div>
</div>

<style>
  .msg { max-width: 85%; padding: 0.75rem 1rem; border-radius: 12px; line-height: 1.5; position: relative; word-break: break-word; font-size: 14px; }
  .msg-user { align-self: flex-end; background: #007bff; color: white; border-bottom-right-radius: 2px; }
  .msg-assistant { align-self: flex-start; background: #333; color: #eee; border-bottom-left-radius: 2px; border: 1px solid #444; }
  .msg-system { align-self: center; background: rgba(255,255,255,0.05); color: #888; font-size: 0.8rem; border-radius: 4px; padding: 0.25rem 0.75rem; }
  .typing-indicator::after { content: '...'; animation: typing 1.5s infinite; }
  @keyframes typing { 0% { opacity: 0.2; } 50% { opacity: 1; } 100% { opacity: 0.2; } }
</style>

<script>
  (function() {
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    const wsStatus = document.getElementById('ws-status');
    
    let ws = null;
    let requestId = 0;
    let initId = -1;
    let currentThreadId = null;
    let currentMessageDiv = null;
    let currentMessageText = '';
    
    function appendMessage(role, text, isStreaming = false) {
      const div = document.createElement('div');
      div.className = \`msg msg-\${role}\`;
      if (isStreaming) div.classList.add('typing-indicator');
      div.textContent = text;
      chatMessages.appendChild(div);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return div;
    }

    function updateStatus(text, color) {
      wsStatus.textContent = text;
      wsStatus.style.color = color || 'inherit';
    }

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = \`\${protocol}//\${window.location.host}${ADMIN_UI_PATH}/ws\`;
      
      appendMessage('system', \`正在連線至 \${wsUrl}...\`);
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        updateStatus('已連線', '#28a745');
        appendMessage('system', 'WebSocket 已開啟，等待 200ms 後發送 initialize...');

        // Give proxy/backend a brief moment to stabilize
        setTimeout(() => {
          initId = sendRpc('initialize', {
            clientInfo: { name: 'codex-worker-web', version: '1.0.0' },
            capabilities: { experimentalApi: true }
          });
        }, 200);

        // Timeout warning
        const timer = setTimeout(() => {
          if (!currentThreadId) {
            appendMessage('system', '警告: 初始化超時，請檢查伺服器日誌（docker logs）。');
          }
        }, 8000);
      };

      ws.onclose = (e) => {
        updateStatus('連線中斷', '#dc3545');
        appendMessage('system', \`連線已關閉 (code=\${e.code}, reason=\${e.reason})\`);
      };

      ws.onerror = (e) => {
        appendMessage('system', 'WebSocket 發生錯誤');
      };

      ws.onmessage = async (e) => {
        console.log('RAW MSG:', e.data); // Log to browser console
        try {
          const raw = (typeof e.data === 'string') ? e.data : await e.data.text();
          const msg = JSON.parse(raw);
          handleRpc(msg);
        } catch (err) {
          appendMessage('system', 'WS 訊息解析失敗: ' + (err && err.message ? err.message : String(err)));
        }
      };
      }

      function sendRpc(method, params) {
      const id = ++requestId;
      const payload = { jsonrpc: '2.0', id, method, params };
      console.log('SEND RPC:', payload);
      ws.send(JSON.stringify(payload));
      return id;
      }

      function handleRpc(msg) {
      // 1. Handle Handshake
      if (msg.id === initId && msg.result) {
        appendMessage('system', '收到初始化回應，發送 initialized 通知...');
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
        sendRpc('thread/start', {});
      } 
 else if (msg.result && msg.result.thread) {
        currentThreadId = msg.result.thread.id;
        appendMessage('system', \`執行緒已建立: \${currentThreadId}\`);
      } else if (msg.method === 'item/started') {
        if (msg.params.item.type === 'agentMessage') {
          currentMessageDiv = appendMessage('assistant', '', true);
          currentMessageText = '';
        }
      } else if (msg.method === 'item/agentMessage/delta') {
        if (currentMessageDiv) {
          currentMessageText += msg.params.delta;
          currentMessageDiv.textContent = currentMessageText;
          chatMessages.scrollTop = chatMessages.scrollHeight;
        }
      } else if (msg.method === 'item/completed') {
        if (msg.params.item.type === 'agentMessage') {
          if (currentMessageDiv) {
            currentMessageDiv.classList.remove('typing-indicator');
            currentMessageDiv.textContent = msg.params.item.text;
            currentMessageDiv = null;
          }
        }
      } else if (msg.method === 'turn/completed') {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.focus();
      } else if (msg.error) {
        appendMessage('system', \`RPC Error: \${msg.error.message}\`);
        chatInput.disabled = false;
        sendBtn.disabled = false;
      }
    }

    function sendMessage() {
      const text = chatInput.value.trim();
      if (!text || !currentThreadId || chatInput.disabled) return;
      
      appendMessage('user', text);
      chatInput.value = '';
      chatInput.style.height = 'auto';
      chatInput.disabled = true;
      sendBtn.disabled = true;
      
      sendRpc('turn/start', {
        threadId: currentThreadId,
        input: [{ type: 'text', text }]
      });
    }

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    
    sendBtn.addEventListener('click', sendMessage);
    
    chatInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
    });

    connect();
  })();
</script>
`;
}

module.exports = {
  isAdminAuthorized,
  setAdminAuthCookieIfNeeded,
  serveStaticFile,
  renderAdminPage,
  renderDashboardPartial,
  renderSchedulesPartial,
  renderMemoriesPartial,
  renderContextsPartial,
  renderEventsPartial,
  renderChatPartial,
};
