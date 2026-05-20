const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const WebSocket = require('ws');
const { 
  PORT, ADMIN_UI_PATH, ADMIN_UI_ENABLE, ADMIN_AUTH_TOKEN, 
  TASK_CONCURRENCY, TASK_QUEUE_MAX, PATHNAME,
  APP_SERVER_TOKEN_FILE, APP_SERVER_WS_URL
} = require('../config');
const { log, getLogContext } = require('../logger');
const { 
  isAdminAuthorized, setAdminAuthCookieIfNeeded, serveStaticFile, 
  renderAdminPage, renderDashboardPartial, renderSchedulesPartial, renderMemoriesPartial,
  renderContextsPartial, renderEventsPartial, renderChatPartial
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

      // SSE Endpoint for real-time events
      if (url.pathname === `${ADMIN_UI_PATH}/events`) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        
        const { eventEmitter } = require('../logger');
        const onLog = (data) => {
          res.write(`event: log\ndata: ${JSON.stringify(data)}\n\n`);
        };
        
        eventEmitter.on('log', onLog);
        
        req.on('close', () => {
          eventEmitter.removeListener('log', onLog);
        });
        return;
      }

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
      if (url.pathname === `${ADMIN_UI_PATH}/partials/events`) {
        sendHtml(res, 200, await renderEventsPartial());
        return;
      }
      if (url.pathname === `${ADMIN_UI_PATH}/partials/chat`) {
        sendHtml(res, 200, await renderChatPartial());
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

  // WebSocket Proxy for codex app-server
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    if (ADMIN_UI_ENABLE === 'true' && url.pathname === `${ADMIN_UI_PATH}/ws`) {
      if (!isAdminAuthorized(req, url)) {
        log('Unauthorized WS upgrade attempt', { level: 'warn' });
        socket.destroy();
        return;
      }

      // Read internal app-server token
      let appServerToken = '';
      try {
        if (fs.existsSync(APP_SERVER_TOKEN_FILE)) {
          // Use hex-like sanitization or just replace all whitespace
          appServerToken = fs.readFileSync(APP_SERVER_TOKEN_FILE, 'utf8').replace(/\s+/g, '');
          log(`Read app-server token (length: ${appServerToken.length})`);
        }
      } catch (err) {
        log(`Failed to read app-server token: ${err.message}`, { level: 'error' });
      }

      const wss = new WebSocket.Server({ noServer: true });
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        log('Admin WS connected, proxying to codex app-server at ' + APP_SERVER_WS_URL);
        
        // Clone headers and remove Origin
        const headers = {
          'Authorization': `Bearer ${appServerToken}`
        };
        
        const targetWs = new WebSocket(APP_SERVER_WS_URL, {
          headers,
          handshakeTimeout: 5000
        });

        let targetReady = false;
        const buffer = [];

        // 1. Handle messages from Browser Client
        clientWs.on('message', (data) => {
          const msgStr = data.toString();
          log(`Client -> Proxy: ${msgStr.slice(0, 100)}${msgStr.length > 100 ? '...' : ''}`);
          if (targetReady && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(data);
          } else {
            buffer.push(data);
          }
        });

        // 2. Handle messages from Codex Backend
        targetWs.on('message', (data) => {
          const msgStr = data.toString();
          log(`Proxy <- Backend: ${msgStr.slice(0, 100)}${msgStr.length > 100 ? '...' : ''}`);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
          }
        });

        targetWs.on('open', () => {
          log('Successfully connected to codex app-server at 9090');
          targetReady = true;
          if (buffer.length > 0) {
            log(`Flushing ${buffer.length} messages to backend`);
            while (buffer.length > 0) {
              targetWs.send(buffer.shift());
            }
          }
        });

        const cleanup = () => {
          clientWs.close();
          targetWs.close();
        };

        targetWs.on('close', () => {
          log('Backend WS closed');
          cleanup();
        });
        clientWs.on('close', () => {
          log('Client WS closed');
          cleanup();
        });

        targetWs.on('error', (err) => {
          log(`Failed to reach codex app-server (9090): ${err.message}`, { level: 'error' });
          clientWs.send(JSON.stringify({ 
            error: { code: -32000, message: `無法連接到後端 Codex 服務 (9090): ${err.message}` } 
          }));
          cleanup();
        });
        
        clientWs.on('error', (err) => {
          log(`Client WS error: ${err.message}`, { level: 'error' });
          cleanup();
        });
      });
      return;
    }

    // Default: destroy unknown upgrades
    socket.destroy();
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
