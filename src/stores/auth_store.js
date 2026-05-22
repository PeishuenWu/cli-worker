'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

class AuthStore {
  constructor(options = {}) {
    this.dbPath = options.dbPath || '/home/codex/.codex/auth/fido.sqlite';
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
    const schema = [
      'PRAGMA journal_mode=WAL;',
      'CREATE TABLE IF NOT EXISTS fido_credentials (',
      '  id TEXT PRIMARY KEY,', // credentialID (base64url)
      '  public_key TEXT NOT NULL,', // publicKey (base64url)
      '  counter INTEGER NOT NULL DEFAULT 0,',
      '  transports TEXT,', // JSON array of transports
      '  created_at TEXT NOT NULL',
      ');',
      'CREATE TABLE IF NOT EXISTS fido_challenges (',
      '  challenge TEXT PRIMARY KEY,',
      '  user_id TEXT NOT NULL,',
      '  expires_at INTEGER NOT NULL',
      ');',
      'CREATE TABLE IF NOT EXISTS sessions (',
      '  id TEXT PRIMARY KEY,',
      '  user_id TEXT NOT NULL,',
      '  expires_at INTEGER NOT NULL',
      ');',
    ].join('\n');
    await this.runSql(schema);
  }

  escape(str) {
    return String(str || '').replace(/'/g, "''");
  }

  async saveSession(sessionId, userId, expiresAtMs) {
    const sql = `INSERT INTO sessions (id, user_id, expires_at) VALUES ('${this.escape(sessionId)}', '${this.escape(userId)}', ${Number(expiresAtMs)});`;
    await this.runSql(sql);
  }

  async getSession(sessionId) {
    const sql = `SELECT * FROM sessions WHERE id = '${this.escape(sessionId)}';`;
    const res = await this.runSql(sql, { json: true });
    const rows = res.trim() ? JSON.parse(res) : [];
    if (rows.length === 0) return null;
    return rows[0];
  }

  async deleteSession(sessionId) {
    const sql = `DELETE FROM sessions WHERE id = '${this.escape(sessionId)}';`;
    await this.runSql(sql);
  }

  async cleanupSessions() {
    const now = Date.now();
    const sql = `DELETE FROM sessions WHERE expires_at < ${now};`;
    await this.runSql(sql);
  }

  async saveCredential(cred) {
    const { id, publicKey, counter, transports } = cred;
    const now = new Date().toISOString();
    const sql = `INSERT OR REPLACE INTO fido_credentials (id, public_key, counter, transports, created_at)
      VALUES ('${this.escape(id)}', '${this.escape(publicKey)}', ${Number(counter)}, '${this.escape(JSON.stringify(transports || []))}', '${now}');`;
    await this.runSql(sql);
  }

  async getCredential(id) {
    const sql = `SELECT * FROM fido_credentials WHERE id = '${this.escape(id)}';`;
    const res = await this.runSql(sql, { json: true });
    const rows = res.trim() ? JSON.parse(res) : [];
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      publicKey: row.public_key,
      counter: Number(row.counter),
      transports: JSON.parse(row.transports || '[]'),
    };
  }

  async listCredentials() {
    const sql = `SELECT * FROM fido_credentials ORDER BY created_at DESC;`;
    const res = await this.runSql(sql, { json: true });
    return res.trim() ? JSON.parse(res) : [];
  }

  async deleteCredential(id) {
    const sql = `DELETE FROM fido_credentials WHERE id = '${this.escape(id)}';`;
    await this.runSql(sql);
  }

  async updateCounter(id, counter) {
    const sql = `UPDATE fido_credentials SET counter = ${Number(counter)} WHERE id = '${this.escape(id)}';`;
    await this.runSql(sql);
  }

  async saveChallenge(challenge, userId, expiresAtMs) {
    const sql = `INSERT INTO fido_challenges (challenge, user_id, expires_at) VALUES ('${this.escape(challenge)}', '${this.escape(userId)}', ${Number(expiresAtMs)});`;
    await this.runSql(sql);
  }

  async getChallenge(challenge) {
    const sql = `SELECT * FROM fido_challenges WHERE challenge = '${this.escape(challenge)}';`;
    const res = await this.runSql(sql, { json: true });
    const rows = res.trim() ? JSON.parse(res) : [];
    if (rows.length === 0) return null;
    return rows[0];
  }

  async deleteChallenge(challenge) {
    const sql = `DELETE FROM fido_challenges WHERE challenge = '${this.escape(challenge)}';`;
    await this.runSql(sql);
  }

  async cleanupChallenges() {
    const now = Date.now();
    const sql = `DELETE FROM fido_challenges WHERE expires_at < ${now};`;
    await this.runSql(sql);
  }
}

module.exports = { AuthStore };
