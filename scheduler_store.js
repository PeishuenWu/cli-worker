#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function nowIso() {
  return new Date().toISOString();
}

class SchedulerStore {
  constructor(options = {}) {
    this.enabled = String(options.enabled || 'false') === 'true';
    this.dbPath = options.dbPath || '/home/codex/.codex/scheduler/jobs.sqlite';
    this.maxList = Number(options.maxList || 20);
  }

  async init() {
    if (!this.enabled) return;
    await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });

    const baseSchema = [
      'PRAGMA journal_mode=WAL;',
      'CREATE TABLE IF NOT EXISTS jobs (',
      '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
      "  type TEXT NOT NULL DEFAULT 'one_time',",
      '  prompt TEXT NOT NULL,',
      '  run_at TEXT NOT NULL,',
      '  cron_expr TEXT,',
      "  timezone TEXT NOT NULL DEFAULT 'Asia/Taipei',",
      "  status TEXT NOT NULL DEFAULT 'active',",
      '  channel TEXT,',
      '  username TEXT,',
      '  retry_count INTEGER NOT NULL DEFAULT 0,',
      '  max_retries INTEGER NOT NULL DEFAULT 3,',
      '  retry_base_seconds INTEGER NOT NULL DEFAULT 60,',
      '  last_run_at TEXT,',
      '  last_result TEXT,',
      '  last_error TEXT,',
      '  created_at TEXT NOT NULL,',
      '  updated_at TEXT NOT NULL',
      ');',
      'CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_at);',
    ].join('\n');

    await this.runSql(baseSchema);
    await this.migrateColumns();
  }

  async migrateColumns() {
    const infoRaw = await this.runSql("PRAGMA table_info('jobs');", { json: true });
    const columns = (infoRaw.trim() ? JSON.parse(infoRaw) : []).map((c) => String(c.name || ''));
    const missing = [];

    const required = [
      { name: 'type', sql: "ALTER TABLE jobs ADD COLUMN type TEXT NOT NULL DEFAULT 'one_time';" },
      { name: 'cron_expr', sql: 'ALTER TABLE jobs ADD COLUMN cron_expr TEXT;' },
      { name: 'timezone', sql: "ALTER TABLE jobs ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Taipei';" },
      { name: 'retry_count', sql: 'ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;' },
      { name: 'max_retries', sql: 'ALTER TABLE jobs ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 3;' },
      { name: 'retry_base_seconds', sql: 'ALTER TABLE jobs ADD COLUMN retry_base_seconds INTEGER NOT NULL DEFAULT 60;' },
      { name: 'last_error', sql: 'ALTER TABLE jobs ADD COLUMN last_error TEXT;' },
    ];

    for (const col of required) {
      if (!columns.includes(col.name)) missing.push(col.sql);
    }

    for (const sql of missing) {
      await this.runSql(sql);
    }
  }

  escape(str) {
    return String(str || '').replace(/'/g, "''");
  }

  asInt(v, fallback = 0) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.trunc(n);
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

  async createOneTime({ prompt, runAtIso, channel, username, timezone, maxRetries, retryBaseSeconds }) {
    if (!this.enabled) throw new Error('scheduler_disabled');

    const now = nowIso();
    const maxR = Math.max(0, this.asInt(maxRetries, 3));
    const retryBase = Math.max(10, this.asInt(retryBaseSeconds, 60));

    const sql = [
      'BEGIN;',
      'INSERT INTO jobs(type, prompt, run_at, cron_expr, timezone, status, channel, username, retry_count, max_retries, retry_base_seconds, created_at, updated_at)',
      'VALUES(',
      "  'one_time',",
      `  '${this.escape(prompt)}',`,
      `  '${this.escape(runAtIso)}',`,
      '  NULL,',
      `  '${this.escape(timezone || 'Asia/Taipei')}',`,
      "  'active',",
      `  '${this.escape(channel || '')}',`,
      `  '${this.escape(username || '')}',`,
      '  0,',
      `  ${maxR},`,
      `  ${retryBase},`,
      `  '${now}',`,
      `  '${now}'`,
      ');',
      'SELECT last_insert_rowid() AS id;',
      'COMMIT;',
    ].join('\n');

    const out = await this.runSql(sql);
    const m = out.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  async createCron({ prompt, runAtIso, cronExpr, channel, username, timezone, maxRetries, retryBaseSeconds }) {
    if (!this.enabled) throw new Error('scheduler_disabled');

    const now = nowIso();
    const maxR = Math.max(0, this.asInt(maxRetries, 3));
    const retryBase = Math.max(10, this.asInt(retryBaseSeconds, 60));

    const sql = [
      'BEGIN;',
      'INSERT INTO jobs(type, prompt, run_at, cron_expr, timezone, status, channel, username, retry_count, max_retries, retry_base_seconds, created_at, updated_at)',
      'VALUES(',
      "  'cron',",
      `  '${this.escape(prompt)}',`,
      `  '${this.escape(runAtIso)}',`,
      `  '${this.escape(cronExpr)}',`,
      `  '${this.escape(timezone || 'Asia/Taipei')}',`,
      "  'active',",
      `  '${this.escape(channel || '')}',`,
      `  '${this.escape(username || '')}',`,
      '  0,',
      `  ${maxR},`,
      `  ${retryBase},`,
      `  '${now}',`,
      `  '${now}'`,
      ');',
      'SELECT last_insert_rowid() AS id;',
      'COMMIT;',
    ].join('\n');

    const out = await this.runSql(sql);
    const m = out.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  async listJobs(limit = this.maxList) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || this.maxList, 100));
    const sql = [
      'SELECT',
      '  id, type, prompt, run_at, cron_expr, timezone, status, channel, username, retry_count, max_retries, retry_base_seconds, created_at, updated_at, last_run_at, last_result, last_error',
      'FROM jobs',
      "WHERE status IN ('active','running','paused','failed')",
      'ORDER BY run_at ASC',
      `LIMIT ${safeLimit};`,
    ].join('\n');

    const out = await this.runSql(sql, { json: true });
    return out.trim() ? JSON.parse(out) : [];
  }

  async listJobsAll(limit = this.maxList) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || this.maxList, 200));
    const sql = [
      'SELECT',
      '  id, type, prompt, run_at, cron_expr, timezone, status, channel, username, retry_count, max_retries, retry_base_seconds, created_at, updated_at, last_run_at, last_result, last_error',
      'FROM jobs',
      'ORDER BY updated_at DESC',
      `LIMIT ${safeLimit};`,
    ].join('\n');

    const out = await this.runSql(sql, { json: true });
    return out.trim() ? JSON.parse(out) : [];
  }

  async listJobsByUser(username, limit = this.maxList) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || this.maxList, 100));
    const name = this.escape(String(username || ''));
    const sql = [
      'SELECT',
      '  id, type, prompt, run_at, cron_expr, timezone, status, channel, username, retry_count, max_retries, retry_base_seconds, created_at, updated_at, last_run_at, last_result, last_error',
      'FROM jobs',
      `WHERE username='${name}'`,
      "  AND status IN ('active','running','paused','failed')",
      'ORDER BY run_at ASC',
      `LIMIT ${safeLimit};`,
    ].join('\n');

    const out = await this.runSql(sql, { json: true });
    return out.trim() ? JSON.parse(out) : [];
  }

  async getJobById(id) {
    if (!this.enabled) return null;
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) return null;
    const sql = [
      'SELECT',
      '  id, type, prompt, run_at, cron_expr, timezone, status, channel, username, retry_count, max_retries, retry_base_seconds, created_at, updated_at, last_run_at, last_result, last_error',
      'FROM jobs',
      `WHERE id=${jobId}`,
      'LIMIT 1;',
    ].join('\n');
    const out = await this.runSql(sql, { json: true });
    const rows = out.trim() ? JSON.parse(out) : [];
    return rows[0] || null;
  }

  async countActiveByUser(username) {
    if (!this.enabled) return 0;
    const name = this.escape(String(username || ''));
    const sql = [
      'SELECT COUNT(*) AS c',
      'FROM jobs',
      `WHERE username='${name}'`,
      "  AND status IN ('active','running','paused','failed');",
    ].join('\n');
    const out = await this.runSql(sql, { json: true });
    const rows = out.trim() ? JSON.parse(out) : [];
    return this.asInt(rows[0]?.c, 0);
  }

  async countActiveByChannel(channel) {
    if (!this.enabled) return 0;
    const c = this.escape(String(channel || ''));
    const sql = [
      'SELECT COUNT(*) AS c',
      'FROM jobs',
      `WHERE channel='${c}'`,
      "  AND status IN ('active','running','paused','failed');",
    ].join('\n');
    const out = await this.runSql(sql, { json: true });
    const rows = out.trim() ? JSON.parse(out) : [];
    return this.asInt(rows[0]?.c, 0);
  }

  async cancelJob(id) {
    if (!this.enabled) throw new Error('scheduler_disabled');
    const now = nowIso();
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('invalid_job_id');

    const sql = [
      `UPDATE jobs SET status='canceled', updated_at='${now}' WHERE id=${jobId} AND status IN ('active','running','paused','failed');`,
      'SELECT changes() AS changed;',
    ].join('\n');

    const out = await this.runSql(sql);
    const m = out.match(/(\d+)/);
    return m ? Number(m[1]) > 0 : false;
  }

  async pauseJob(id) {
    if (!this.enabled) throw new Error('scheduler_disabled');
    const now = nowIso();
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('invalid_job_id');

    const sql = [
      `UPDATE jobs SET status='paused', updated_at='${now}' WHERE id=${jobId} AND status IN ('active','failed');`,
      'SELECT changes() AS changed;',
    ].join('\n');

    const out = await this.runSql(sql);
    const m = out.match(/(\d+)/);
    return m ? Number(m[1]) > 0 : false;
  }

  async resumeJob(id) {
    if (!this.enabled) throw new Error('scheduler_disabled');
    const now = nowIso();
    const jobId = Number(id);
    if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('invalid_job_id');

    const sql = [
      `UPDATE jobs SET status='active', run_at=CASE WHEN run_at < '${now}' THEN '${now}' ELSE run_at END, updated_at='${now}' WHERE id=${jobId} AND status='paused';`,
      'SELECT changes() AS changed;',
    ].join('\n');

    const out = await this.runSql(sql);
    const m = out.match(/(\d+)/);
    return m ? Number(m[1]) > 0 : false;
  }

  async claimDueJobs(limit = 5) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
    const now = nowIso();

    const selectSql = [
      'SELECT id, type, prompt, run_at, cron_expr, timezone, channel, username, retry_count, max_retries, retry_base_seconds',
      'FROM jobs',
      "WHERE status='active'",
      `  AND run_at <= '${now}'`,
      'ORDER BY run_at ASC',
      `LIMIT ${safeLimit};`,
    ].join('\n');

    const out = await this.runSql(selectSql, { json: true });
    const rows = out.trim() ? JSON.parse(out) : [];
    const claimed = [];

    for (const row of rows) {
      const id = Number(row.id);
      const lockSql = [
        'BEGIN;',
        `UPDATE jobs SET status='running', updated_at='${now}' WHERE id=${id} AND status='active';`,
        'SELECT changes() AS changed;',
        'COMMIT;',
      ].join('\n');

      const lockOut = await this.runSql(lockSql);
      const m = lockOut.match(/(\d+)/);
      const changed = m ? Number(m[1]) : 0;
      if (changed > 0) claimed.push(row);
    }

    return claimed;
  }

  async completeOneTime(id, result) {
    if (!this.enabled) return;
    const now = nowIso();
    const sql = [
      `UPDATE jobs SET status='done', retry_count=0, last_run_at='${now}', last_result='${this.escape(result)}', last_error=NULL, updated_at='${now}' WHERE id=${Number(id)};`,
    ].join('\n');
    await this.runSql(sql);
  }

  async completeCron(id, result, nextRunIso) {
    if (!this.enabled) return;
    const now = nowIso();
    const sql = [
      `UPDATE jobs SET status='active', run_at='${this.escape(nextRunIso)}', retry_count=0, last_run_at='${now}', last_result='${this.escape(result)}', last_error=NULL, updated_at='${now}' WHERE id=${Number(id)};`,
    ].join('\n');
    await this.runSql(sql);
  }

  async markRetryOrFailed(id, errMsg, retryCount, maxRetries, retryBaseSeconds) {
    if (!this.enabled) return { status: 'ignored' };

    const now = nowIso();
    const currRetry = Math.max(0, this.asInt(retryCount, 0));
    const maxR = Math.max(0, this.asInt(maxRetries, 3));
    const base = Math.max(10, this.asInt(retryBaseSeconds, 60));

    if (currRetry < maxR) {
      const nextRetry = currRetry + 1;
      const delaySec = Math.min(base * Math.pow(2, nextRetry - 1), 3600);
      const runAt = new Date(Date.now() + delaySec * 1000).toISOString();
      const sql = [
        `UPDATE jobs SET status='active', run_at='${runAt}', retry_count=${nextRetry}, last_run_at='${now}', last_error='${this.escape(errMsg)}', updated_at='${now}' WHERE id=${Number(id)};`,
      ].join('\n');
      await this.runSql(sql);
      return { status: 'retry', runAt, retryCount: nextRetry, delaySec };
    }

    const sql = [
      `UPDATE jobs SET status='failed', last_run_at='${now}', last_error='${this.escape(errMsg)}', updated_at='${now}' WHERE id=${Number(id)};`,
    ].join('\n');
    await this.runSql(sql);
    return { status: 'failed' };
  }

  async cleanupOldJobs(retentionDays = 30) {
    if (!this.enabled) return 0;
    const days = Math.max(1, this.asInt(retentionDays, 30));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const sql = [
      `DELETE FROM jobs WHERE status IN ('done','canceled','failed') AND updated_at < '${cutoff}';`,
      'SELECT changes() AS changed;',
    ].join('\n');
    const out = await this.runSql(sql);
    const m = out.match(/(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  async getStatusCounts() {
    if (!this.enabled) return {};
    const sql = [
      'SELECT status, COUNT(*) AS c',
      'FROM jobs',
      'GROUP BY status;',
    ].join('\n');
    const out = await this.runSql(sql, { json: true });
    const rows = out.trim() ? JSON.parse(out) : [];
    const counts = {};
    for (const row of rows) {
      counts[String(row.status || 'unknown')] = this.asInt(row.c, 0);
    }
    return counts;
  }
}

module.exports = {
  SchedulerStore,
};
