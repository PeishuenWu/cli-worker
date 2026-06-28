'use strict';

const { codexChatSessionStore } = require('../stores');
const {
  searchArchivedSessions,
  getArchivedSession,
  getArchivedSessionByThreadId,
} = require('../services/codex_archived_sessions');

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
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

async function handleAdminChatSessionApi(req, res, url, adminUiPath) {
  if (req.method === 'GET' && url.pathname === `${adminUiPath}/chat/archives`) {
    const query = String(url.searchParams.get('search') || '').trim();
    const archives = await searchArchivedSessions(query, { limit: 30 });
    sendJson(res, 200, { archives });
    return true;
  }

  if (req.method === 'GET' && url.pathname === `${adminUiPath}/chat/sessions`) {
    const sessions = await codexChatSessionStore.listSessions(100);
    sendJson(res, 200, { sessions });
    return true;
  }

  const threadArchiveMatch = url.pathname.match(new RegExp(`^${adminUiPath}/chat/threads/([^/]+)/archive$`));
  if (req.method === 'GET' && threadArchiveMatch) {
    const threadId = decodeURIComponent(threadArchiveMatch[1]);
    const archive = await getArchivedSessionByThreadId(threadId);
    if (!archive) {
      sendJson(res, 404, { error: 'archive_not_found' });
      return true;
    }
    sendJson(res, 200, { archive });
    return true;
  }

  if (req.method === 'POST' && url.pathname === `${adminUiPath}/chat/sessions`) {
    const rawBody = await readBody(req);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const session = await codexChatSessionStore.createSession(body.title || 'New Session', body.description || '');
    sendJson(res, 201, { session });
    return true;
  }

  const archiveImportMatch = url.pathname.match(new RegExp(`^${adminUiPath}/chat/archives/([^/]+)/import$`));
  if (req.method === 'POST' && archiveImportMatch) {
    const archiveId = decodeURIComponent(archiveImportMatch[1]);
    const archive = await getArchivedSession(archiveId);
    const session = await codexChatSessionStore.createSessionWithMessages(
      archive.title,
      archive.messages,
      archive.relative_path || archive.last_message || ''
    );
    sendJson(res, 201, { session, archive });
    return true;
  }

  const archiveMatch = url.pathname.match(new RegExp(`^${adminUiPath}/chat/archives/([^/]+)$`));
  if (req.method === 'GET' && archiveMatch) {
    const archiveId = decodeURIComponent(archiveMatch[1]);
    const archive = await getArchivedSession(archiveId);
    sendJson(res, 200, { archive });
    return true;
  }

  const sessionMatch = url.pathname.match(new RegExp(`^${adminUiPath}/chat/sessions/([^/]+)$`));
  if (!sessionMatch) return false;

  const sessionId = decodeURIComponent(sessionMatch[1]);
  if (req.method === 'GET') {
    const session = await codexChatSessionStore.getSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'session_not_found' });
      return true;
    }
    sendJson(res, 200, { session });
    return true;
  }

  if (req.method === 'PATCH') {
    const rawBody = await readBody(req);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(body, 'title')) updates.title = body.title;
    if (Object.prototype.hasOwnProperty.call(body, 'description')) updates.description = body.description;
    if (Object.prototype.hasOwnProperty.call(body, 'threadId')) updates.threadId = body.threadId;
    if (Object.prototype.hasOwnProperty.call(body, 'messages')) updates.messages = body.messages;
    const session = await codexChatSessionStore.updateSession(sessionId, updates);
    if (!session) {
      sendJson(res, 404, { error: 'session_not_found' });
      return true;
    }
    sendJson(res, 200, { session });
    return true;
  }

  if (req.method === 'DELETE') {
    const deleted = await codexChatSessionStore.deleteSession(sessionId);
    if (!deleted) {
      sendJson(res, 404, { error: 'session_not_found' });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = {
  handleAdminChatSessionApi,
};
