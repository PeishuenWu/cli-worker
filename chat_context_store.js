#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch (_e) {
    return fallback;
  }
}

class ChatContextStore {
  constructor(options = {}) {
    this.enabled = String(options.enabled || 'true') === 'true';
    this.dbPath = options.dbPath || '/home/codex/.codex/chat_context/context.sqlite';
    this.maxMessagesPerChannel = Math.max(2, Math.min(Number(options.maxMessagesPerChannel || 10), 50));
    this.maxMessageChars = Math.max(200, Math.min(Number(options.maxMessageChars || 2000), 10000));
    this.channelLocks = new Map();
  }

  escape(str) {
    return String(str || '').replace(/'/g, "''");
  }

  async runSql(sql, { json = false } = {}) {
    if (!this.enabled) return '';
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
    if (!this.enabled) return;
    await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
    const sql = [
      'PRAGMA journal_mode=WAL;',
      'CREATE TABLE IF NOT EXISTS channel_context (',
      '  channel_id TEXT PRIMARY KEY,',
      '  history_json TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_channel_context_updated_at ON channel_context(updated_at);',
    ].join('\n');
    await this.runSql(sql);
  }

  withChannelLock(channelId, fn) {
    const key = String(channelId || 'unknown');
    const previous = this.channelLocks.get(key) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(fn);
    this.channelLocks.set(key, current.finally(() => {
      if (this.channelLocks.get(key) === current) {
        this.channelLocks.delete(key);
      }
    }));
    return current;
  }

  sanitizeMessage(role, text) {
    const cleanRole = role === 'assistant' ? 'assistant' : 'user';
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, this.maxMessageChars);
    if (!cleanText) return null;
    return { role: cleanRole, text: cleanText };
  }

  async getHistory(channelId) {
    if (!this.enabled || !channelId) return [];
    const id = this.escape(String(channelId));
    const sql = [
      'SELECT history_json',
      'FROM channel_context',
      `WHERE channel_id='${id}'`,
      'LIMIT 1;',
    ].join('\n');
    const out = await this.runSql(sql, { json: true });
    const rows = out.trim() ? JSON.parse(out) : [];
    const historyJson = String(rows[0]?.history_json || '[]');
    const raw = safeJsonParse(historyJson, []);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => this.sanitizeMessage(item?.role, item?.text))
      .filter(Boolean)
      .slice(-this.maxMessagesPerChannel);
  }

  async appendMessage(channelId, role, text) {
    if (!this.enabled || !channelId) return;
    const normalized = this.sanitizeMessage(role, text);
    if (!normalized) return;

    await this.withChannelLock(channelId, async () => {
      const existing = await this.getHistory(channelId);
      existing.push(normalized);
      const trimmed = existing.slice(-this.maxMessagesPerChannel);
      const historyJson = this.escape(JSON.stringify(trimmed));
      const now = nowIso();
      const id = this.escape(String(channelId));
      const sql = [
        'INSERT INTO channel_context(channel_id, history_json, updated_at)',
        `VALUES('${id}', '${historyJson}', '${now}')`,
        'ON CONFLICT(channel_id) DO UPDATE SET',
        `  history_json='${historyJson}',`,
        `  updated_at='${now}';`,
      ].join('\n');
      await this.runSql(sql);
    });
  }

  async formatRecentHistory(channelId) {
    const history = await this.getHistory(channelId);
    if (history.length === 0) return '';
    return `### 最近對話內容 (Short-term Context):\n${history.map((h) => `${h.role === 'user' ? '使用者' : '助理'}: ${h.text}`).join('\n')}\n`;
  }
}

module.exports = {
  ChatContextStore,
};
