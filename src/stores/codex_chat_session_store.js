'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch (_err) {
    return fallback;
  }
}

class CodexChatSessionStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || '/home/codex/.codex/codex_chat/sessions.sqlite';
    this.maxMessagesPerSession = Math.max(10, Math.min(Number(options.maxMessagesPerSession || 200), 1000));
    this.maxMessageChars = Math.max(200, Math.min(Number(options.maxMessageChars || 8000), 20000));
  }

  escape(str) {
    return String(str || '').replace(/'/g, "''");
  }

  async runSql(sql, { json = false } = {}) {
    const args = [];
    if (json) args.push('-json');
    args.push(this.dbPath);

    return new Promise((resolve, reject) => {
      const proc = spawn('sqlite3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `sqlite3 exited ${code}`));
          return;
        }
        resolve(stdout);
      });

      proc.stdin.write(sql);
      proc.stdin.end();
    });
  }

  async init() {
    await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
    const sql = [
      'PRAGMA journal_mode=WAL;',
      'CREATE TABLE IF NOT EXISTS codex_chat_sessions (',
      '  id TEXT PRIMARY KEY,',
      '  title TEXT NOT NULL,',
      '  thread_id TEXT,',
      '  messages_json TEXT NOT NULL,',
      '  created_at TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_codex_chat_sessions_updated_at ON codex_chat_sessions(updated_at DESC);',
    ].join('\n');
    await this.runSql(sql);
  }

  normalizeTitle(title) {
    const text = String(title || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 120) || 'New Session';
  }

  normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
      .map((message) => {
        const role = ['user', 'assistant', 'system'].includes(message?.role) ? message.role : null;
        const text = String(message?.text || '').replace(/\s+/g, ' ').trim().slice(0, this.maxMessageChars);
        if (!role || !text) return null;
        return { role, text };
      })
      .filter(Boolean)
      .slice(-this.maxMessagesPerSession);
  }

  buildSessionSummary(row) {
    const messages = safeJsonParse(row.messages_json, []);
    const lastMessage = Array.isArray(messages) && messages.length > 0 ? messages[messages.length - 1] : null;
    return {
      id: row.id,
      title: row.title,
      thread_id: row.thread_id || '',
      created_at: row.created_at,
      updated_at: row.updated_at,
      message_count: Array.isArray(messages) ? messages.length : 0,
      last_message: lastMessage ? String(lastMessage.text || '') : '',
    };
  }

  async listSessions(limit = 100) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const sql = [
      'SELECT id, title, thread_id, messages_json, created_at, updated_at',
      'FROM codex_chat_sessions',
      'ORDER BY updated_at DESC',
      `LIMIT ${safeLimit};`,
    ].join('\n');
    const out = await this.runSql(sql, { json: true });
    const rows = out.trim() ? JSON.parse(out) : [];
    return rows.map((row) => this.buildSessionSummary(row));
  }

  async getSession(sessionId) {
    const sql = [
      'SELECT id, title, thread_id, messages_json, created_at, updated_at',
      'FROM codex_chat_sessions',
      `WHERE id='${this.escape(sessionId)}'`,
      'LIMIT 1;',
    ].join('\n');
    const out = await this.runSql(sql, { json: true });
    const rows = out.trim() ? JSON.parse(out) : [];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      ...this.buildSessionSummary(row),
      messages: this.normalizeMessages(safeJsonParse(row.messages_json, [])),
    };
  }

  async createSession(title = 'New Session') {
    const sessionId = crypto.randomUUID();
    const now = nowIso();
    const normalizedTitle = this.normalizeTitle(title);
    const sql = [
      'INSERT INTO codex_chat_sessions (id, title, thread_id, messages_json, created_at, updated_at)',
      `VALUES ('${this.escape(sessionId)}', '${this.escape(normalizedTitle)}', '', '[]', '${now}', '${now}');`,
    ].join('\n');
    await this.runSql(sql);
    return this.getSession(sessionId);
  }

  async createSessionWithMessages(title = 'Imported Session', messages = []) {
    const session = await this.createSession(title);
    return this.updateSession(session.id, {
      title,
      messages,
      threadId: '',
    });
  }

  async updateSession(sessionId, updates = {}) {
    const existing = await this.getSession(sessionId);
    if (!existing) return null;

    const title = Object.prototype.hasOwnProperty.call(updates, 'title')
      ? this.normalizeTitle(updates.title)
      : existing.title;
    const threadId = Object.prototype.hasOwnProperty.call(updates, 'threadId')
      ? String(updates.threadId || '').trim().slice(0, 255)
      : String(existing.thread_id || '');
    const messages = Object.prototype.hasOwnProperty.call(updates, 'messages')
      ? this.normalizeMessages(updates.messages)
      : existing.messages;
    const updatedAt = nowIso();
    const sql = [
      'UPDATE codex_chat_sessions',
      `SET title='${this.escape(title)}',`,
      `    thread_id='${this.escape(threadId)}',`,
      `    messages_json='${this.escape(JSON.stringify(messages))}',`,
      `    updated_at='${updatedAt}'`,
      `WHERE id='${this.escape(sessionId)}';`,
    ].join('\n');
    await this.runSql(sql);
    return this.getSession(sessionId);
  }
}

module.exports = {
  CodexChatSessionStore,
};
