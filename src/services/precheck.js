'use strict';

const fs = require('fs');
const path = require('path');
const { log } = require('../logger');
const config = require('../config');

async function runPrecheck() {
  log('Starting environment pre-check...');
  let errors = 0;

  // 1. Check critical env vars
  if (!config.VERIFY_TOKEN) {
    log('[ERROR] SYNCHAT_OUTGOING_TOKEN is missing. Outgoing webhooks will be rejected.');
    errors++;
  }
  if (!config.INCOMING_URL) {
    log('[WARN] SYNCHAT_INCOMING_URL is missing. Bridge will fallback to synchronous replies (not recommended for production).');
  }
  if (!config.OPENAI_API_KEY) {
    log('[WARN] OPENAI_API_KEY is missing. Long-term memory system (vector search) will be disabled.');
  }
  if (!config.ADMIN_AUTH_TOKEN) {
    log('[WARN] ADMIN_AUTH_TOKEN is not set. Admin UI will be unprotected!');
  }

  // 2. Check directories and permissions
  const dirsToCheck = [
    { path: config.CODEX_WORKDIR, name: 'CODEX_WORKDIR' },
    { path: config.DOWNLOADS_DIR, name: 'Downloads' },
    { path: config.UPLOADS_DIR, name: 'Uploads' }
  ];

  for (const dir of dirsToCheck) {
    try {
      if (!fs.existsSync(dir.path)) {
        log(`[INFO] Creating directory: ${dir.path} (${dir.name})`);
        fs.mkdirSync(dir.path, { recursive: true });
      }
      // Test write permission
      const testFile = path.join(dir.path, `.precheck_${Date.now()}`);
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
    } catch (err) {
      log(`[ERROR] Directory ${dir.path} (${dir.name}) is not writable: ${err.message}`);
      errors++;
    }
  }

  // 3. Check SQLite database paths
  const dbPaths = [];
  if (config.CHAT_CONTEXT_ENABLE === 'true') dbPaths.push({ path: config.CHAT_CONTEXT_DB_PATH, name: 'Chat Context' });
  if (config.SCHEDULER_ENABLE === 'true') dbPaths.push({ path: config.SCHEDULER_DB_PATH, name: 'Scheduler' });

  for (const db of dbPaths) {
    const dir = path.dirname(db.path);
    try {
      if (!fs.existsSync(dir)) {
        log(`[INFO] Creating database directory: ${dir} (${db.name})`);
        fs.mkdirSync(dir, { recursive: true });
      }
      // Test write permission in the directory
      const testFile = path.join(dir, `.db_precheck_${Date.now()}`);
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
    } catch (err) {
      log(`[ERROR] Database directory ${dir} (${db.name}) is not writable: ${err.message}`);
      errors++;
    }
  }

  if (errors > 0) {
    log(`[FATAL] Pre-check failed with ${errors} error(s). Please fix your configuration.`);
    process.exit(1);
  }

  log('Environment pre-check passed.');
}

module.exports = {
  runPrecheck,
};
