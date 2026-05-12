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
            hx-get="${ADMIN_UI_PATH}/partials/memories" 
            hx-target="#tab-content"
            onclick="switchTab(this)">
            記憶列表
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
          <td title="${escapeHtml(String(row.summary || ''))}">${escapeHtml(shortText(row.summary, 100))}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>
</div>`;
}



module.exports = {
  isAdminAuthorized,
  setAdminAuthCookieIfNeeded,
  serveStaticFile,
  renderAdminPage,
  renderDashboardPartial,
  renderSchedulesPartial,
  renderMemoriesPartial,
};
