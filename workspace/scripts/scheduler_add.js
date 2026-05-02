#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

const dbPath = process.env.SCHEDULER_DB_PATH || '/home/codex/.codex/scheduler/jobs.sqlite';

function escapeSql(value) {
  return String(value || '').replace(/'/g, "''");
}

function runSql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => stdout += data.toString());
    child.stderr.on('data', data => stderr += data);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `Exit code ${code}`));
      resolve(stdout.trim());
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const type = args[0]; // one_time or cron
  const runAtInput = args[1]; // Time string
  const user = args[2];
  const channel = args[3];
  const prompt = args.slice(4).join(' ');

  if (!type || !runAtInput || !prompt) {
    console.error("用法: node scheduler_add.js <type> <runAt> <user> <channel> <prompt>");
    process.exit(1);
  }
  if (!['one_time', 'cron'].includes(type)) {
    console.error('錯誤: type 只允許 one_time 或 cron');
    process.exit(1);
  }

  // 解析時間：如果傳入的是純時間字串，Node 會根據伺服器本地時區解析，然後轉為 UTC ISO
  const dateObj = new Date(runAtInput);
  if (isNaN(dateObj.getTime())) {
    console.error(`錯誤: 無法解析時間格式 "${runAtInput}"`);
    process.exit(1);
  }
  const runAt = dateObj.toISOString();
  const safePrompt = escapeSql(prompt);
  const safeUser = escapeSql(user || '');
  const safeChannel = escapeSql(channel || '');

  const now = new Date().toISOString();
  const sql = [
    'BEGIN;',
    'INSERT INTO jobs (type, prompt, run_at, status, username, channel, created_at, updated_at)',
    `VALUES ('${type}', '${safePrompt}', '${runAt}', 'active', '${safeUser}', '${safeChannel}', '${now}', '${now}');`,
    'SELECT last_insert_rowid() AS id;',
    'COMMIT;',
  ].join('\n');

  const out = await runSql(sql);
  const match = out.match(/(\d+)/);
  const jobId = match ? Number(match[1]) : 0;
  console.log(`成功建立排程任務 #${jobId}。預定執行時間 (UTC): ${runAt}`);
}

main().catch(err => {
  console.error("建立失敗:", err.message);
  process.exit(1);
});
