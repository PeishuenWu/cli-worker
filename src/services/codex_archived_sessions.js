'use strict';

const fs = require('fs');
const path = require('path');
const { CODEX_ARCHIVED_SESSIONS_DIR } = require('../config');

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch (_err) {
    return null;
  }
}

function normalizeText(text, maxChars = 400) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function preserveMessageText(text, maxChars = 8000) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+|\n+$/g, '')
    .slice(0, maxChars);
}

function looksLikeInstructionPrompt(text) {
  const normalized = normalizeText(text, 300);
  if (!normalized) return false;
  const promptSignals = [
    '只輸出 JSON',
    '不要 markdown',
    'JSON schema',
    '當前系統時間',
    '檔案與目錄規範',
    'Downloads/',
    '如果使用者是在詢問',
    '你是任務分類器',
    '你是排程參數抽取器',
    '你是任務規劃器',
  ];
  if (normalized.length > 100 && normalized.startsWith('你是 ')) return true;
  return promptSignals.some((signal) => normalized.includes(signal));
}

function summarizeAssistantMessage(text) {
  const normalized = normalizeText(text, 240);
  if (!normalized) return '';

  const parsed = safeJsonParse(normalized);
  if (parsed && typeof parsed === 'object') {
    if (parsed.summary) return normalizeText(parsed.summary, 80);
    if (parsed.action && parsed.reason) return normalizeText(`${parsed.action}: ${parsed.reason}`, 80);
    if (parsed.action) return normalizeText(`exec ${parsed.action}`, 80);
  }

  return normalizeText(normalized, 80);
}

function encodeArchiveId(relativePath) {
  return Buffer.from(relativePath, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeArchiveId(archiveId) {
  const normalized = String(archiveId || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function getArchivedSessionsRoot() {
  const configured = path.resolve(CODEX_ARCHIVED_SESSIONS_DIR);
  if (fs.existsSync(configured)) return configured;

  const localRepoFallback = path.resolve(__dirname, '../../codex/sessions');
  if (fs.existsSync(localRepoFallback)) return localRepoFallback;

  return configured;
}

function buildArchiveTitle(summary) {
  if (summary.messages.length > 0) {
    const firstUserMessage = summary.messages.find((message) => message.role === 'user');
    if (firstUserMessage && !looksLikeInstructionPrompt(firstUserMessage.text)) {
      return normalizeText(firstUserMessage.text, 120) || summary.session_id;
    }

    const firstAssistantMessage = summary.messages.find((message) => message.role === 'assistant');
    if (firstAssistantMessage) {
      const assistantTitle = summarizeAssistantMessage(firstAssistantMessage.text);
      if (assistantTitle) return assistantTitle;
    }
  }
  const baseName = path.basename(summary.relative_path || '', '.jsonl');
  return summary.session_id || baseName || summary.relative_path;
}

async function listJsonlFiles(rootDir) {
  const results = [];

  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        return;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(fullPath);
      }
    }));
  }

  await walk(rootDir);
  return results.sort().reverse();
}

async function parseArchiveFile(filePath, rootDir = CODEX_ARCHIVED_SESSIONS_DIR) {
  const content = await fs.promises.readFile(filePath, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  const messages = [];
  let sessionMeta = null;
  let turnCount = 0;

  for (const line of lines) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== 'object') continue;

    if (parsed.type === 'session_meta' && parsed.payload) {
      sessionMeta = parsed.payload;
      continue;
    }

    if (parsed.type === 'event_msg' && parsed.payload?.type === 'user_message') {
      const text = preserveMessageText(parsed.payload.message, 8000);
      if (text) messages.push({ role: 'user', text });
      continue;
    }

    if (parsed.type === 'event_msg' && parsed.payload?.type === 'task_complete') {
      const text = preserveMessageText(parsed.payload.last_agent_message, 8000);
      if (text) messages.push({ role: 'assistant', text });
      turnCount += 1;
    }
  }

  const relativePath = path.relative(rootDir, filePath);
  const stat = await fs.promises.stat(filePath);
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const summary = {
    id: encodeArchiveId(relativePath),
    relative_path: relativePath,
    file_path: filePath,
    session_id: String(sessionMeta?.session_id || sessionMeta?.id || path.basename(filePath, '.jsonl')),
    created_at: String(sessionMeta?.timestamp || stat.birthtime.toISOString()),
    updated_at: String(stat.mtime.toISOString()),
    cwd: String(sessionMeta?.cwd || ''),
    originator: String(sessionMeta?.originator || ''),
    source: String(sessionMeta?.source || ''),
    cli_version: String(sessionMeta?.cli_version || ''),
    model_provider: String(sessionMeta?.model_provider || ''),
    turn_count: turnCount,
    message_count: messages.length,
    last_message: lastMessage ? normalizeText(lastMessage.text, 140) : '',
    messages,
  };

  summary.title = buildArchiveTitle(summary);
  return summary;
}

function matchesArchive(summary, query) {
  if (!query) return true;
  const q = String(query || '').toLowerCase().trim();
  if (!q) return true;

  const haystacks = [
    summary.title,
    summary.session_id,
    summary.relative_path,
    summary.cwd,
    summary.originator,
    summary.source,
    summary.cli_version,
    summary.model_provider,
    ...summary.messages.slice(0, 8).map((message) => message.text),
    summary.last_message,
  ].map((value) => String(value || '').toLowerCase());

  return haystacks.some((value) => value.includes(q));
}

async function searchArchivedSessions(query, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 30, 100));
  const rootDir = getArchivedSessionsRoot();
  const files = await listJsonlFiles(rootDir);
  const results = [];

  for (const filePath of files) {
    try {
      const summary = await parseArchiveFile(filePath, rootDir);
      if (!matchesArchive(summary, query)) continue;
      results.push({
        id: summary.id,
        title: summary.title,
        session_id: summary.session_id,
        relative_path: summary.relative_path,
        created_at: summary.created_at,
        updated_at: summary.updated_at,
        cwd: summary.cwd,
        originator: summary.originator,
        source: summary.source,
        model_provider: summary.model_provider,
        turn_count: summary.turn_count,
        message_count: summary.message_count,
        last_message: summary.last_message,
      });
      if (results.length >= limit) break;
    } catch (_err) {
      continue;
    }
  }

  return results;
}

async function getArchivedSession(archiveId) {
  const relativePath = decodeArchiveId(archiveId);
  const rootDir = getArchivedSessionsRoot();
  const filePath = path.resolve(rootDir, relativePath);
  if (!filePath.startsWith(path.resolve(rootDir) + path.sep)) {
    throw new Error('invalid_archive_id');
  }
  return parseArchiveFile(filePath, rootDir);
}

async function getArchivedSessionByThreadId(threadId) {
  const targetThreadId = String(threadId || '').trim();
  if (!targetThreadId) return null;

  const rootDir = getArchivedSessionsRoot();
  const files = await listJsonlFiles(rootDir);
  for (const filePath of files) {
    try {
      const summary = await parseArchiveFile(filePath, rootDir);
      if (summary.session_id === targetThreadId) return summary;
    } catch (_err) {
      continue;
    }
  }
  return null;
}

module.exports = {
  searchArchivedSessions,
  getArchivedSession,
  getArchivedSessionByThreadId,
};
