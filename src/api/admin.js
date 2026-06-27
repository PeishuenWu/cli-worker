'use strict';

const fs = require('fs');
const path = require('path');
const { 
  ADMIN_AUTH_TOKEN, DOWNLOADS_DIR, ADMIN_UI_PATH, SCHEDULER_ENABLE, 
  MEMORY_PROJECT, ADMIN_UI_MEMORY_LIMIT, ADMIN_UI_SCHEDULE_LIMIT 
} = require('../config');
const { metrics } = require('../logger');
const { schedulerStore, memoryStore, authStore } = require('../stores');
const { parseCookies, escapeHtml, shortText, fmtTs } = require('../utils');
const { isSessionAuthorized } = require('./auth');

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

async function isAdminAuthorized(req, urlObj) {
  if (!ADMIN_AUTH_TOKEN) return true;
  const token = getAdminTokenFromRequest(req, urlObj);
  if (token && token === ADMIN_AUTH_TOKEN) return true;
  return await isSessionAuthorized(req);
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
            Codex Chat
          </button>
        </li>
        <li>
          <button 
            hx-get="${ADMIN_UI_PATH}/partials/security" 
            hx-target="#tab-content"
            onclick="switchTab(this)">
            安全性 (FIDO)
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
  <h2>Codex Chat</h2>
  <div style="display: flex; align-items: center; gap: 0.75rem;">
    <span class="muted">可建立新 session，或還原先前已記錄的 Codex Chat session</span>
    <button id="session-sidebar-toggle-btn" class="secondary" style="margin: 0; padding: 0.25rem 0.65rem; font-size: 0.75rem; width: auto;">隱藏管理</button>
  </div>
</div>

<div id="codex-chat-layout" class="chat-layout" style="display: grid; grid-template-columns: 300px 1fr; gap: 1rem; min-height: calc(100vh - 350px);">
  <aside id="session-sidebar" style="border: 1px solid #333; border-radius: 8px; background: #141414; overflow: hidden;">
    <div style="padding: 1rem; border-bottom: 1px solid #333; display: flex; gap: 0.5rem; align-items: center;">
      <button id="new-session-btn" style="margin: 0; flex: 1;">建立新 Session</button>
      <span id="session-count" class="muted" style="font-size: 0.75rem;">載入中...</span>
    </div>
    <div style="padding: 0.75rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <div style="color: #aaa; font-size: 0.75rem;">目前 Session</div>
        <button id="session-toggle-btn" class="secondary" style="margin: 0; padding: 0.15rem 0.5rem; font-size: 0.7rem; width: auto;">展開</button>
      </div>
      <div id="session-section-body" class="sidebar-section-body is-hidden">
        <input id="session-search-input" type="search" placeholder="搜尋 session..." style="margin: 0 0 0.5rem; background: #1f1f1f; border-color: #3a3a3a; color: #eee;">
        <div id="session-list" style="max-height: 240px; overflow-y: auto; padding: 0.25rem 0;"></div>
      </div>
    </div>
    <div style="border-top: 1px solid #333; padding: 0.75rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <div style="color: #aaa; font-size: 0.75rem;">Archived Sessions</div>
          <span id="archive-count" class="muted" style="font-size: 0.75rem;">0 筆</span>
        </div>
        <button id="archive-toggle-btn" class="secondary" style="margin: 0; padding: 0.15rem 0.5rem; font-size: 0.7rem; width: auto;">展開</button>
      </div>
      <div id="archive-section-body" class="sidebar-section-body is-hidden">
        <input id="archive-search-input" type="search" placeholder="搜尋 archived session..." style="margin: 0 0 0.5rem; background: #1f1f1f; border-color: #3a3a3a; color: #eee;">
        <div id="archive-list" style="max-height: calc(100vh - 720px); min-height: 180px; overflow-y: auto; padding: 0 0.5rem 0.5rem;"></div>
      </div>
    </div>
  </aside>

  <div id="chat-container" style="display: flex; flex-direction: column; height: calc(100vh - 350px); background: #111; border-radius: 8px; border: 1px solid #333; overflow: hidden;">
    <div style="padding: 0.75rem 1rem; border-bottom: 1px solid #333; background: #161616; display: flex; justify-content: space-between; gap: 1rem;">
      <div>
        <div id="active-session-title" style="font-weight: 600; color: #eee;">尚未選擇 Session</div>
        <div id="active-session-meta" class="muted" style="font-size: 0.75rem;">請先建立新 session，或還原既有 session。</div>
      </div>
      <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 0.4rem;">
        <div id="thread-info" class="muted" style="font-size: 0.75rem; text-align: right;"></div>
        <button id="archive-import-btn" class="secondary" style="display: none; margin: 0; padding: 0.25rem 0.6rem; font-size: 0.75rem; width: auto;">匯入成新 Session</button>
      </div>
    </div>

    <div id="chat-messages" style="flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; gap: 1rem;">
      <div id="chat-empty-state" style="text-align: center; color: #666; font-size: 0.9rem; margin-top: 2rem;">
        <p>Codex Chat 可直接與後端 app-server 溝通。</p>
        <p>支援建立新 session，或還原已記錄的 session 與 thread。</p>
      </div>
    </div>
    
    <div id="chat-input-area" style="padding: 1rem; background: #1a1a1a; border-top: 1px solid #333;">
      <div style="display: flex; gap: 0.5rem; align-items: flex-end;">
        <textarea id="chat-input" placeholder="輸入訊息... (Shift+Enter 換行, Enter 送出)" rows="1" 
          style="margin: 0; background: #222; border-color: #444; color: #eee; resize: none; overflow-y: hidden; min-height: 44px;" disabled></textarea>
        <button id="chat-send-btn" style="width: auto; margin: 0; padding: 0.5rem 1rem; height: 44px;" disabled>送出</button>
      </div>
      <div id="chat-status" class="muted" style="margin-top: 0.5rem; font-size: 0.75rem;">
        連線狀態: <span id="ws-status">正在連線...</span>
        <button id="ws-reconnect-btn" class="secondary" style="display: none; margin-left: 0.75rem; padding: 0.15rem 0.5rem; font-size: 0.7rem; width: auto;">重新連線</button>
      </div>
    </div>
  </div>
</div>

<style>
  .session-item { padding: 0.75rem; border: 1px solid #2d2d2d; border-radius: 8px; cursor: pointer; background: #1a1a1a; color: #ddd; margin-bottom: 0.5rem; }
  .session-item:hover { border-color: #4a4a4a; background: #202020; }
  .session-item.active { border-color: #0d6efd; background: rgba(13,110,253,0.12); }
  .archive-item { padding: 0.65rem 0.75rem; border: 1px solid #2d2d2d; border-radius: 8px; cursor: pointer; background: #191919; color: #ddd; margin-bottom: 0.5rem; }
  .archive-item:hover { border-color: #4a4a4a; background: #202020; }
  .archive-item.active { border-color: #20c997; background: rgba(32,201,151,0.12); }
  .session-title { font-size: 0.9rem; font-weight: 600; margin-bottom: 0.25rem; }
  .session-preview { color: #888; font-size: 0.75rem; line-height: 1.4; }
  .chat-layout.sidebar-hidden { grid-template-columns: 1fr !important; }
  .chat-layout.sidebar-hidden #session-sidebar { display: none; }
  .sidebar-section-body.is-hidden { display: none; }
  .msg { max-width: 85%; padding: 0.75rem 1rem; border-radius: 12px; line-height: 1.5; position: relative; word-break: break-word; font-size: 14px; }
  .msg-user { align-self: flex-end; background: #007bff; color: white; border-bottom-right-radius: 2px; }
  .msg-assistant { align-self: flex-start; background: #333; color: #eee; border-bottom-left-radius: 2px; border: 1px solid #444; }
  .msg-system { align-self: center; background: rgba(255,255,255,0.05); color: #888; font-size: 0.8rem; border-radius: 4px; padding: 0.25rem 0.75rem; }
  .typing-indicator::after { content: '...'; animation: typing 1.5s infinite; }
  @keyframes typing { 0% { opacity: 0.2; } 50% { opacity: 1; } 100% { opacity: 0.2; } }
</style>

<script>
  (function() {
    const chatLayout = document.getElementById('codex-chat-layout');
    const sessionSidebar = document.getElementById('session-sidebar');
    const sessionSidebarToggleBtn = document.getElementById('session-sidebar-toggle-btn');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send-btn');
    const wsStatus = document.getElementById('ws-status');
    const activeSessionTitle = document.getElementById('active-session-title');
    const activeSessionMeta = document.getElementById('active-session-meta');
    const threadInfo = document.getElementById('thread-info');
    const sessionList = document.getElementById('session-list');
    const sessionCount = document.getElementById('session-count');
    const newSessionBtn = document.getElementById('new-session-btn');
    const sessionSearchInput = document.getElementById('session-search-input');
    const sessionToggleBtn = document.getElementById('session-toggle-btn');
    const sessionSectionBody = document.getElementById('session-section-body');
    const archiveList = document.getElementById('archive-list');
    const archiveCount = document.getElementById('archive-count');
    const archiveSearchInput = document.getElementById('archive-search-input');
    const archiveToggleBtn = document.getElementById('archive-toggle-btn');
    const archiveSectionBody = document.getElementById('archive-section-body');
    const archiveImportBtn = document.getElementById('archive-import-btn');
    const reconnectBtn = document.getElementById('ws-reconnect-btn');
    
    let ws = null;
    let requestId = 0;
    let initId = -1;
    let currentThreadId = null;
    let currentMessageDiv = null;
    let currentMessageText = '';
    let activeSession = null;
    let sessions = [];
    let archives = [];
    let sessionSearchTerm = '';
    let activeArchive = null;
    let isInitialized = false;
    let pendingTurnText = null;
    let reconnectTimer = null;
    let reconnectAttempts = 0;
    let manualClose = false;
    const MAX_RECONNECT_DELAY_MS = 10000;
    const SIDEBAR_HIDDEN_STORAGE_KEY = 'codex-chat-sidebar-hidden';
    
    function appendMessage(role, text, isStreaming = false) {
      const emptyState = document.getElementById('chat-empty-state');
      if (emptyState) emptyState.remove();
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

    function clearReconnectTimer() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function stopConnectionState() {
      clearReconnectTimer();
    }

    function getReconnectDelay() {
      return Math.min(1000 * Math.max(1, Math.pow(2, reconnectAttempts)), MAX_RECONNECT_DELAY_MS);
    }

    function scheduleReconnect() {
      if (manualClose || reconnectTimer) return;
      reconnectAttempts += 1;
      const delay = getReconnectDelay();
      updateStatus(\`重連中（\${Math.ceil(delay / 1000)} 秒後）\`, '#ff9800');
      reconnectBtn.style.display = 'inline-block';
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect({ isReconnect: true });
      }, delay);
    }

    function formatTs(ts) {
      if (!ts) return '';
      try {
        return new Date(ts).toLocaleString();
      } catch (_err) {
        return String(ts);
      }
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function updateSessionHeader() {
      if (!activeSession) {
        activeSessionTitle.textContent = '尚未選擇 Session';
        activeSessionMeta.textContent = '請先建立新 session，或還原既有 session。';
        threadInfo.textContent = '';
        archiveImportBtn.style.display = activeArchive ? 'inline-block' : 'none';
        chatInput.disabled = true;
        sendBtn.disabled = true;
        return;
      }
      archiveImportBtn.style.display = 'none';
      activeSessionTitle.textContent = activeSession.title;
      activeSessionMeta.textContent = \`最後更新: \${formatTs(activeSession.updated_at)} | 訊息數: \${(activeSession.messages || []).length}\`;
      threadInfo.textContent = activeSession.thread_id ? \`thread: \${activeSession.thread_id}\` : 'thread: 尚未建立';
      chatInput.disabled = !isInitialized;
      sendBtn.disabled = !isInitialized;
    }

    function updateSectionToggle(button, body) {
      button.textContent = body.classList.contains('is-hidden') ? '展開' : '隱藏';
    }

    function toggleSection(button, body) {
      body.classList.toggle('is-hidden');
      updateSectionToggle(button, body);
    }

    function setSidebarHidden(hidden) {
      chatLayout.classList.toggle('sidebar-hidden', hidden);
      sessionSidebar.setAttribute('aria-hidden', hidden ? 'true' : 'false');
      sessionSidebarToggleBtn.textContent = hidden ? '顯示管理' : '隱藏管理';
      try {
        window.localStorage.setItem(SIDEBAR_HIDDEN_STORAGE_KEY, hidden ? '1' : '0');
      } catch (_err) {}
    }

    function toggleSidebar() {
      setSidebarHidden(!chatLayout.classList.contains('sidebar-hidden'));
    }

    function renderSessionList() {
      const normalizedTerm = sessionSearchTerm.trim().toLowerCase();
      const filteredSessions = normalizedTerm
        ? sessions.filter((session) => {
            const haystack = [
              session.title || '',
              session.last_message || '',
              session.id || '',
            ].join('\\n').toLowerCase();
            return haystack.includes(normalizedTerm);
          })
        : sessions;
      sessionCount.textContent = \`\${sessions.length} 筆\`;
      sessionList.innerHTML = filteredSessions.map((session) => {
        const isActive = activeSession && activeSession.id === session.id;
        const preview = session.last_message || '尚無訊息';
        return \`
          <div class="session-item \${isActive ? 'active' : ''}" data-session-id="\${escapeHtml(session.id)}">
            <div class="session-title">\${escapeHtml(session.title)}</div>
            <div class="session-preview">\${escapeHtml(preview.slice(0, 80))}</div>
            <div class="muted" style="font-size: 0.7rem; margin-top: 0.35rem;">
              \${escapeHtml(formatTs(session.updated_at))} | \${escapeHtml(String(session.message_count || 0))} 則
            </div>
          </div>
        \`;
      }).join('') || '<div class="muted" style="padding: 0.75rem 0;">沒有符合的 session</div>';

      sessionList.querySelectorAll('[data-session-id]').forEach((el) => {
        el.addEventListener('click', () => {
          loadSession(el.getAttribute('data-session-id'));
        });
      });
    }

    function renderArchiveList() {
      archiveCount.textContent = \`\${archives.length} 筆\`;
      archiveList.innerHTML = archives.map((archive) => {
        const isActive = activeArchive && activeArchive.id === archive.id;
        return \`
          <div class="archive-item \${isActive ? 'active' : ''}" data-archive-id="\${escapeHtml(archive.id)}">
            <div class="session-title">\${escapeHtml(archive.title)}</div>
            <div class="session-preview">\${escapeHtml((archive.last_message || archive.relative_path || '').slice(0, 90))}</div>
            <div class="muted" style="font-size: 0.7rem; margin-top: 0.35rem;">
              \${escapeHtml(formatTs(archive.updated_at))} | \${escapeHtml(String(archive.turn_count || 0))} turns
            </div>
          </div>
        \`;
      }).join('') || '<div class="muted" style="padding: 0.75rem;">沒有符合的 archived session</div>';

      archiveList.querySelectorAll('[data-archive-id]').forEach((el) => {
        el.addEventListener('click', () => {
          loadArchive(el.getAttribute('data-archive-id'));
        });
      });
    }

    function renderMessages(messages) {
      chatMessages.innerHTML = '';
      if (!messages || messages.length === 0) {
        chatMessages.innerHTML = '<div id="chat-empty-state" style="text-align: center; color: #666; font-size: 0.9rem; margin-top: 2rem;"><p>這個 session 目前還沒有訊息。</p></div>';
        return;
      }
      messages.forEach((message) => appendMessage(message.role, message.text));
    }

    async function fetchJson(url, options) {
      const response = await fetch(url, options);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || \`request_failed_\${response.status}\`);
      }
      return payload;
    }

    async function refreshSessionList() {
      const payload = await fetchJson('${ADMIN_UI_PATH}/chat/sessions');
      sessions = payload.sessions || [];
      renderSessionList();
    }

    async function refreshArchiveList(search = '') {
      const query = search ? \`?search=\${encodeURIComponent(search)}\` : '';
      const payload = await fetchJson(\`${ADMIN_UI_PATH}/chat/archives\${query}\`);
      archives = payload.archives || [];
      renderArchiveList();
    }

    async function createSession() {
      const payload = await fetchJson('${ADMIN_UI_PATH}/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Session' }),
      });
      await refreshSessionList();
      await loadSession(payload.session.id);
    }

    async function loadSession(sessionId) {
      const payload = await fetchJson(\`${ADMIN_UI_PATH}/chat/sessions/\${encodeURIComponent(sessionId)}\`);
      activeSession = payload.session;
      activeArchive = null;
      currentThreadId = activeSession.thread_id || null;
      pendingTurnText = null;
      renderMessages(activeSession.messages || []);
      updateSessionHeader();
      renderSessionList();
      if (isInitialized) {
        chatInput.focus();
      }
    }

    async function loadArchive(archiveId) {
      const payload = await fetchJson(\`${ADMIN_UI_PATH}/chat/archives/\${encodeURIComponent(archiveId)}\`);
      activeArchive = payload.archive;
      activeSession = null;
      currentThreadId = null;
      pendingTurnText = null;
      renderMessages(activeArchive.messages || []);
      activeSessionTitle.textContent = \`Archived: \${activeArchive.title}\`;
      activeSessionMeta.textContent = \`\${activeArchive.relative_path} | 訊息數: \${(activeArchive.messages || []).length}\`;
      threadInfo.textContent = \`source: \${activeArchive.originator || activeArchive.source || 'archive'}\`;
      archiveImportBtn.style.display = 'inline-block';
      chatInput.disabled = true;
      sendBtn.disabled = true;
      renderSessionList();
      renderArchiveList();
    }

    async function importArchive() {
      if (!activeArchive) return;
      const payload = await fetchJson(\`${ADMIN_UI_PATH}/chat/archives/\${encodeURIComponent(activeArchive.id)}/import\`, {
        method: 'POST',
      });
      await refreshSessionList();
      await loadSession(payload.session.id);
    }

    async function persistSession(extra = {}) {
      if (!activeSession) return;
      const title = activeSession.title === 'New Session'
        ? (((activeSession.messages || []).find((message) => message.role === 'user') || {}).text || 'New Session').slice(0, 120)
        : activeSession.title;
      const payload = await fetchJson(\`${ADMIN_UI_PATH}/chat/sessions/\${encodeURIComponent(activeSession.id)}\`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          threadId: currentThreadId || '',
          messages: activeSession.messages || [],
          ...extra,
        }),
      });
      activeSession = payload.session;
      currentThreadId = activeSession.thread_id || null;
      await refreshSessionList();
      updateSessionHeader();
    }

    function connect(options = {}) {
      const isReconnect = Boolean(options.isReconnect);
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = \`\${protocol}//\${window.location.host}${ADMIN_UI_PATH}/ws\`;

      stopConnectionState();
      isInitialized = false;
      chatInput.disabled = true;
      sendBtn.disabled = true;
      reconnectBtn.style.display = 'none';
      updateStatus(isReconnect ? '重新連線中...' : '正在連線...', '#ff9800');
      ws = new WebSocket(wsUrl);
      
      ws.onopen = () => {
        reconnectAttempts = 0;
        updateStatus('已連線', '#28a745');
        reconnectBtn.style.display = 'none';

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
        reconnectBtn.style.display = 'inline-block';
        isInitialized = false;
        chatInput.disabled = true;
        sendBtn.disabled = true;
        if (!manualClose) {
          scheduleReconnect();
        }
      };

      ws.onerror = (e) => {
        updateStatus('連線錯誤', '#dc3545');
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
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('ws_not_connected');
      }
      const id = ++requestId;
      const payload = { jsonrpc: '2.0', id, method, params };
      console.log('SEND RPC:', payload);
      ws.send(JSON.stringify(payload));
      return id;
    }

    function handleRpc(msg) {
      if (msg.id === initId && msg.result) {
        isInitialized = true;
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
        updateSessionHeader();
      } else if (msg.result && msg.result.thread) {
        currentThreadId = msg.result.thread.id;
        if (activeSession) {
          activeSession.thread_id = currentThreadId;
        }
        persistSession().catch((err) => appendMessage('system', 'Session 儲存失敗: ' + err.message));
        if (pendingTurnText && activeSession) {
          const text = pendingTurnText;
          pendingTurnText = null;
          sendRpc('turn/start', {
            threadId: currentThreadId,
            input: [{ type: 'text', text }]
          });
        }
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
          if (activeSession) {
            activeSession.messages = activeSession.messages || [];
            activeSession.messages.push({ role: 'assistant', text: msg.params.item.text });
            persistSession().catch((err) => appendMessage('system', 'Session 儲存失敗: ' + err.message));
          }
        }
      } else if (msg.method === 'turn/completed') {
        chatInput.disabled = false;
        sendBtn.disabled = false;
        chatInput.focus();
      } else if (msg.error) {
        appendMessage('system', \`RPC Error: \${msg.error.message}\`);
        if (/thread/i.test(String(msg.error.message || '')) && activeSession && currentThreadId) {
          appendMessage('system', '既有 thread 無法還原，將在下次送出時建立新 thread。');
          currentThreadId = null;
          activeSession.thread_id = '';
          persistSession().catch(() => {});
        }
        chatInput.disabled = false;
        sendBtn.disabled = false;
      }
    }

    function sendMessage() {
      const text = chatInput.value.trim();
      if (!text || !activeSession || chatInput.disabled || !isInitialized) return;
      
      appendMessage('user', text);
      activeSession.messages = activeSession.messages || [];
      activeSession.messages.push({ role: 'user', text });
      chatInput.value = '';
      chatInput.style.height = 'auto';
      chatInput.disabled = true;
      sendBtn.disabled = true;
      persistSession().catch((err) => appendMessage('system', 'Session 儲存失敗: ' + err.message));

      const sendTurn = () => {
        try {
          sendRpc('turn/start', {
            threadId: currentThreadId,
            input: [{ type: 'text', text }]
          });
        } catch (err) {
          pendingTurnText = text;
          appendMessage('system', '連線暫時不可用，訊息已保留，重連後會再送出。');
          scheduleReconnect();
        }
      };

      if (!currentThreadId) {
        pendingTurnText = text;
        try {
          sendRpc('thread/start', {});
        } catch (err) {
          appendMessage('system', '目前無法建立 thread，將在重連後重試。');
          scheduleReconnect();
        }
        return;
      }

      sendTurn();
    }

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    
    sessionSidebarToggleBtn.addEventListener('click', toggleSidebar);
    sendBtn.addEventListener('click', sendMessage);
    newSessionBtn.addEventListener('click', () => {
      createSession().catch((err) => appendMessage('system', '建立 session 失敗: ' + err.message));
    });
    sessionToggleBtn.addEventListener('click', () => {
      toggleSection(sessionToggleBtn, sessionSectionBody);
    });
    sessionSearchInput.addEventListener('input', () => {
      sessionSearchTerm = sessionSearchInput.value;
      renderSessionList();
    });
    archiveImportBtn.addEventListener('click', () => {
      importArchive().catch((err) => appendMessage('system', '匯入 archived session 失敗: ' + err.message));
    });
    archiveToggleBtn.addEventListener('click', () => {
      toggleSection(archiveToggleBtn, archiveSectionBody);
    });
    reconnectBtn.addEventListener('click', () => {
      clearReconnectTimer();
      connect({ isReconnect: true });
    });
    archiveSearchInput.addEventListener('input', () => {
      clearTimeout(window._archiveSearchTimer);
      window._archiveSearchTimer = setTimeout(() => {
        refreshArchiveList(archiveSearchInput.value).catch((err) => {
          appendMessage('system', '讀取 archived sessions 失敗: ' + err.message);
        });
      }, 250);
    });
    
    chatInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = (this.scrollHeight) + 'px';
    });

    try {
      setSidebarHidden(window.localStorage.getItem(SIDEBAR_HIDDEN_STORAGE_KEY) === '1');
    } catch (_err) {
      setSidebarHidden(false);
    }
    updateSectionToggle(sessionToggleBtn, sessionSectionBody);
    updateSectionToggle(archiveToggleBtn, archiveSectionBody);
    connect();
    refreshSessionList().catch((err) => {
      appendMessage('system', '讀取 session 清單失敗: ' + err.message);
      sessionCount.textContent = '讀取失敗';
    });
    refreshArchiveList().catch((err) => {
      appendMessage('system', '讀取 archived sessions 失敗: ' + err.message);
      archiveCount.textContent = '讀取失敗';
    });
    window.addEventListener('beforeunload', () => {
      manualClose = true;
      stopConnectionState();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
  })();
</script>
`;
}

async function renderSecurityPartial() {
  const credentials = await authStore.listCredentials();
  
  const rows = credentials.map(cred => `
    <tr>
      <td><code>${escapeHtml(cred.id.slice(0, 16))}...</code></td>
      <td>${escapeHtml(fmtTs(cred.created_at))}</td>
      <td>${cred.counter}</td>
      <td>
        <button class="outline contrast" 
          hx-delete="${ADMIN_UI_PATH}/security/keys/${encodeURIComponent(cred.id)}"
          hx-target="closest tr"
          hx-swap="outerHTML"
          hx-confirm="確定要刪除此安全密鑰嗎？">
          刪除
        </button>
      </td>
    </tr>
  `).join('');

  return `
    <div class="card">
      <div class="card-header">
        <h2>安全性與 FIDO 認證</h2>
        <button hx-on:click="registerNewKey()" id="reg-btn">註冊新密鑰</button>
      </div>
      <p class="muted">在此管理用於登入的管理員 FIDO 安全密鑰 (USB 或 NFC)。</p>
      
      <table role="grid">
        <thead>
          <tr>
            <th>密鑰 ID</th>
            <th>註冊時間</th>
            <th>計數器</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="4" style="text-align:center">尚未註冊任何密鑰</td></tr>'}
        </tbody>
      </table>
    </div>

    <script src="https://unpkg.com/@simplewebauthn/browser/dist/bundle/index.umd.min.js"></script>
    <script>
      async function registerNewKey() {
        const btn = document.getElementById('reg-btn');
        btn.ariaBusy = 'true';
        btn.disabled = true;

        try {
          const optionsRes = await fetch('${ADMIN_UI_PATH}/webauthn/register-options');
          const options = await optionsRes.json();
          
          if (options.error) throw new Error(options.error);

          const { startRegistration } = SimpleWebAuthnBrowser;
          const regResp = await startRegistration(options);
          
          // Include challenge in the request so the server can look it up
          const verifyBody = { ...regResp, challenge: options.challenge };

          const verifyRes = await fetch('${ADMIN_UI_PATH}/webauthn/register-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(verifyBody),
          });

          const verification = await verifyRes.json();

          if (verification.verified) {
            alert('密鑰註冊成功！');
            htmx.trigger('#tab-content', 'load'); // Reload the partial
          } else {
            throw new Error(verification.error || '驗證失敗');
          }
        } catch (err) {
          console.error(err);
          let msg = err.message;
          if (err.name === 'NotAllowedError') {
            msg = '操作被拒絕。請確保：\\n1. 您正在使用 HTTPS 訪問 (或是 localhost)\\n2. 網址域名與系統設定的 RP_ID 一致\\n3. 您沒有取消認證視窗';
          }
          alert('註冊失敗: ' + msg);
        } finally {
          btn.ariaBusy = 'false';
          btn.disabled = false;
        }
      }
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
  renderSecurityPartial,
};
