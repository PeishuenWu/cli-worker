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
  <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  <style>
    body { font-family: "Noto Sans TC", "PingFang TC", sans-serif; margin: 16px; background: #f6f8fa; color: #222; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 1100px) { .grid { grid-template-columns: 1fr 1fr; } }
    .card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 12px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
    h1, h2 { margin: 0 0 8px 0; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #eaeef2; text-align: left; padding: 6px 4px; vertical-align: top; }
    .muted { color: #57606a; font-size: 12px; }
    code { background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Codex Worker 管理介面</h1>
  <div class="muted">內網模式，無登入。請搭配內網 ACL 使用。</div>
  <div class="grid">
    <section class="card" id="dashboard"
      hx-get="${ADMIN_UI_PATH}/partials/dashboard"
      hx-trigger="load, every 10s"
      hx-swap="innerHTML">
      讀取中...
    </section>
    <section class="card" id="schedules"
      hx-get="${ADMIN_UI_PATH}/partials/schedules"
      hx-trigger="load, every 10s"
      hx-swap="innerHTML">
      讀取中...
    </section>
  </div>
  <section class="card" id="memories"
    hx-get="${ADMIN_UI_PATH}/partials/memories"
    hx-trigger="load, every 15s"
    hx-swap="innerHTML"
    style="margin-top: 12px;">
    讀取中...
  </section>
</body>
</html>`;
}

async function renderDashboardPartial() {
  const statusCounts = await schedulerStore.getStatusCounts().catch(() => ({}));
  const cards = [
    ['Scheduler Ticks', metrics.scheduler_ticks_total],
    ['Jobs Claimed', metrics.scheduler_jobs_claimed_total],
    ['Jobs Success', metrics.scheduler_jobs_success_total],
    ['Jobs Retry', metrics.scheduler_jobs_retry_total],
    ['Jobs Failed', metrics.scheduler_jobs_failed_total],
    ['Cleanup Deleted', metrics.scheduler_cleanup_deleted_total],
    ['Cmd Denied', metrics.schedule_commands_denied_total],
  ];

  const statusText = Object.keys(statusCounts).length === 0
    ? '-'
    : Object.entries(statusCounts).map(([k, v]) => `${escapeHtml(k)}:${v}`).join(' / ');

  return `
<h2>系統總覽</h2>
<div class="muted">Started: ${escapeHtml(metrics.started_at)} | Scheduler: ${String(SCHEDULER_ENABLE)}</div>
<table>
  <thead><tr><th>指標</th><th>數值</th></tr></thead>
  <tbody>
    ${cards.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}
    <tr><td>Job Status</td><td>${statusText}</td></tr>
  </tbody>
</table>`;
}

async function renderSchedulesPartial() {
  const rows = await schedulerStore.listJobsAll(ADMIN_UI_SCHEDULE_LIMIT).catch(() => []);
  return `
<h2>排程列表</h2>
<div class="muted">顯示最近 ${rows.length} 筆（含 done/canceled）</div>
<table>
  <thead>
    <tr><th>ID</th><th>狀態</th><th>類型</th><th>時間</th><th>擁有者</th><th>頻道</th><th>任務</th><th>重試</th></tr>
  </thead>
  <tbody>
    ${rows.map((row) => `
      <tr>
        <td>${escapeHtml(String(row.id || ''))}</td>
        <td>${escapeHtml(String(row.status || ''))}</td>
        <td>${escapeHtml(String(row.type || ''))}${row.cron_expr ? `<br><code>${escapeHtml(String(row.cron_expr))}</code>` : ''}</td>
        <td>${escapeHtml(fmtTs(row.run_at))}</td>
        <td>${escapeHtml(String(row.username || '-'))}</td>
        <td>${escapeHtml(String(row.channel || '-'))}</td>
        <td title="${escapeHtml(String(row.prompt || ''))}">${escapeHtml(shortText(row.prompt, 80))}</td>
        <td>${escapeHtml(String(row.retry_count || 0))}/${escapeHtml(String(row.max_retries || 0))}</td>
      </tr>
    `).join('')}
  </tbody>
</table>`;
}

async function renderMemoriesPartial() {
  const rows = await memoryStore.listRecent({
    project: MEMORY_PROJECT,
    limit: ADMIN_UI_MEMORY_LIMIT,
  }).catch(() => []);

  return `
<h2>記憶列表</h2>
<div class="muted">project=${escapeHtml(MEMORY_PROJECT)}，最近 ${rows.length} 筆</div>
<table>
  <thead>
    <tr><th>ID</th><th>Scope</th><th>來源</th><th>使用者</th><th>時間</th><th>標籤</th><th>摘要</th></tr>
  </thead>
  <tbody>
    ${rows.map((row) => `
      <tr>
        <td>${escapeHtml(String(row.id || ''))}</td>
        <td>${escapeHtml(String(row.scope || ''))}</td>
        <td>${escapeHtml(String(row.source || '-'))}</td>
        <td>${escapeHtml(String(row.username || '-'))}</td>
        <td>${escapeHtml(fmtTs(row.created_at))}</td>
        <td>${escapeHtml((Array.isArray(row.tags) ? row.tags : []).join(', '))}</td>
        <td title="${escapeHtml(String(row.summary || ''))}">${escapeHtml(shortText(row.summary, 120))}</td>
      </tr>
    `).join('')}
  </tbody>
</table>`;
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
