#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

// 從環境變數讀取資料庫路徑，或使用預設路徑
const dbPath = process.env.SCHEDULER_DB_PATH || '/home/codex/.codex/scheduler/jobs.sqlite';

function runSql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-json', dbPath, sql]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || `Exit code ${code}`));
      try {
        resolve(JSON.parse(stdout || '[]'));
      } catch (e) {
        resolve(stdout); // 如果不是 JSON 格式就回傳原始字串
      }
    });
  });
}

async function main() {
  const mode = process.argv[2] || '--list';

  if (mode === '--list') {
    const sql = "SELECT id, status, type, run_at, cron_expr, prompt FROM jobs WHERE status IN ('active', 'running', 'paused', 'failed') ORDER BY run_at ASC LIMIT 10;";
    const jobs = await runSql(sql);
    if (!jobs || jobs.length === 0) {
      console.log("目前沒有待執行的排程任務。");
    } else {
      console.log("=== 目前待執行排程列表 ===");
      jobs.forEach(j => {
        const timeInfo = j.type === 'cron' ? `Cron: ${j.cron_expr}` : `預定時間: ${j.run_at}`;
        console.log(`[#${j.id}] 狀態: ${j.status} | ${timeInfo} | 任務: ${j.prompt.slice(0, 50)}...`);
      });
    }
  } else if (mode === '--help') {
    console.log("用法: node scheduler_query.js [--list]");
  }
}

main().catch(err => {
  console.error("查詢失敗:", err.message);
  process.exit(1);
});
