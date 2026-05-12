const http = require('http');
const https = require('https');
const { URL } = require('url');
const { 
  PORT, ADMIN_UI_PATH, ADMIN_UI_ENABLE, ADMIN_AUTH_TOKEN, 
  TASK_CONCURRENCY, TASK_QUEUE_MAX, PATHNAME 
} = require('../config');
const { log, getLogContext } = require('../logger');
const { 
  isAdminAuthorized, setAdminAuthCookieIfNeeded, serveStaticFile, 
  renderAdminPage, renderDashboardPartial, renderSchedulesPartial, renderMemoriesPartial 
} = require('./admin');

function generateRequestId() {
  return Math.random().toString(36).substring(2, 9) + Date.now().toString(36).substring(4);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  const body = String(html || '');
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error('request_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseIncoming(req, rawBody) {
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  const querystring = require('querystring');
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(rawBody || '{}');
      return { data: parsed, raw: rawBody };
    } catch (e) {
      return { data: {}, raw: rawBody };
    }
  }
  const form = querystring.parse(rawBody || '');
  if (typeof form.payload === 'string') {
    try {
      const parsedPayload = JSON.parse(form.payload);
      return { data: { ...form, ...parsedPayload }, raw: rawBody };
    } catch (_err) {
      return { data: form, raw: rawBody };
    }
  }
  return { data: form, raw: rawBody };
}

function isAuthorized(data, requestId) {
  const { VERIFY_TOKEN } = require('../config');
  if (!VERIFY_TOKEN) return true;
  const allowedTokens = VERIFY_TOKEN.split(',').map(t => t.trim()).filter(Boolean);
  const candidates = [
    data.token,
    data.client_token,
    data.server_token,
    data.outgoing_token,
  ].filter(Boolean);
  const authorized = candidates.some((v) => allowedTokens.includes(String(v)));
  if (!authorized) {
    log(`Unauthorized request: outgoing token mismatch, provided_token_count=${candidates.length}`, getLogContext(requestId, 'warn'));
  }
  return authorized;
}

function logIncomingSummary(req, parsedData) {
  const keys = Object.keys(parsedData || {});
  const tokenPresent = Boolean(parsedData?.token || parsedData?.client_token || parsedData?.server_token || parsedData?.outgoing_token);
  const textLen = String(parsedData?.text || '').length;
  log(`Incoming payload summary: keys=[${keys.join(',')}], token_present=${tokenPresent}, text_len=${textLen}`, getLogContext(req.requestId));
}

function startServer(handleChatRequest) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const requestId = generateRequestId();
    req.requestId = requestId;

    // Public route for files
    if (url.pathname.startsWith('/files/')) {
      const filename = url.pathname.slice('/files/'.length);
      await serveStaticFile(req, res, filename);
      return;
    }

    if (ADMIN_UI_ENABLE === 'true' && url.pathname.startsWith(ADMIN_UI_PATH)) {
      if (!isAdminAuthorized(req, url)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="Admin UI"' });
        res.end('Unauthorized');
        return;
      }
      setAdminAuthCookieIfNeeded(req, res, url);

      if (url.pathname === ADMIN_UI_PATH || url.pathname === `${ADMIN_UI_PATH}/`) {
        sendHtml(res, 200, renderAdminPage());
        return;
      }
      if (url.pathname === `${ADMIN_UI_PATH}/partials/dashboard`) {
        sendHtml(res, 200, await renderDashboardPartial());
        return;
      }
      if (url.pathname === `${ADMIN_UI_PATH}/partials/schedules`) {
        sendHtml(res, 200, await renderSchedulesPartial(url));
        return;
      }
      if (url.pathname === `${ADMIN_UI_PATH}/partials/memories`) {
        sendHtml(res, 200, await renderMemoriesPartial(url));
        return;
      }
      if (url.pathname === `${ADMIN_UI_PATH}/partials/contexts`) {
        sendHtml(res, 200, await renderContextsPartial());
        return;
      }

      // Cancel Schedule
      const cancelMatch = url.pathname.match(new RegExp(`^${ADMIN_UI_PATH}/schedules/(\\d+)/cancel$`));
      if (req.method === 'POST' && cancelMatch) {
        const jobId = cancelMatch[1];
        try {
          const { schedulerStore } = require('../stores');
          await schedulerStore.cancelJob(jobId);
          sendHtml(res, 200, await renderSchedulesPartial(url));
        } catch (err) {
          log(`Admin cancel job failed: ${err.message}`);
          sendHtml(res, 500, `<mark>取消失敗: ${err.message}</mark>`);
        }
        return;
      }

      // Memory Promotion (Short -> Long)
      const promoteMatch = url.pathname.match(new RegExp(`^${ADMIN_UI_PATH}/memories/(.+)/promote$`));
      if (req.method === 'POST' && promoteMatch) {
        const memoryId = promoteMatch[1];
        try {
          const { memoryStore } = require('../stores');
          await memoryStore.promoteToLongTerm(memoryId);
          sendHtml(res, 200, await renderMemoriesPartial(url));
        } catch (err) {
          log(`Admin promote memory failed: ${err.message}`);
          sendHtml(res, 500, `<mark>晉升失敗: ${err.message}</mark>`);
        }
        return;
      }

      // Memory Deletion
      const memoryDeleteMatch = url.pathname.match(new RegExp(`^${ADMIN_UI_PATH}/memories/(.+)$`));
      if (req.method === 'DELETE' && memoryDeleteMatch) {
        const memoryId = memoryDeleteMatch[1];
        try {
          const { memoryStore } = require('../stores');
          await memoryStore.deleteMemory(memoryId);
          sendHtml(res, 200, await renderMemoriesPartial(url));
        } catch (err) {
          log(`Admin delete memory failed: ${err.message}`);
          sendHtml(res, 500, `<mark>刪除失敗: ${err.message}</mark>`);
        }
        return;
      }

      // Context Deletion
      const contextDeleteMatch = url.pathname.match(new RegExp(`^${ADMIN_UI_PATH}/contexts/(.+)$`));
      if (req.method === 'DELETE' && contextDeleteMatch) {
        const channelId = contextDeleteMatch[1];
        try {
          const { chatContextStore } = require('../stores');
          await chatContextStore.deleteContext(channelId);
          sendHtml(res, 200, await renderContextsPartial());
        } catch (err) {
          log(`Admin delete context failed: ${err.message}`);
          sendHtml(res, 500, `<mark>清除失敗: ${err.message}</mark>`);
        }
        return;
      }

      // Backward compatibility for admin files if needed, but /files/ is preferred

      if (url.pathname.startsWith(`${ADMIN_UI_PATH}/files/`)) {
        const filename = url.pathname.slice(`${ADMIN_UI_PATH}/files/`.length);
        await serveStaticFile(req, res, filename);
        return;
      }
    }

    const handled = await handleChatRequest(req, res);
    if (!handled && !res.headersSent) {
      sendJson(res, 404, { error: 'not_found' });
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    log(`chat bridge listening on 0.0.0.0:${PORT}${PATHNAME}`);
    log(`task queue configured: concurrency=${TASK_CONCURRENCY}, max=${TASK_QUEUE_MAX}`);
    if (String(ADMIN_UI_ENABLE) === 'true' && !ADMIN_AUTH_TOKEN) {
      log('security warning: ADMIN_UI_ENABLE=true but ADMIN_AUTH_TOKEN is empty', { level: 'warn' });
    }
  });

  return server;
}

module.exports = {
  sendJson,
  sendHtml,
  readBody,
  parseIncoming,
  isAuthorized,
  logIncomingSummary,
  startServer,
};
