'use strict';

const path = require('path');

const PORT = Number(process.env.CHAT_BRIDGE_PORT || 8090);
const PATHNAME = process.env.CHAT_BRIDGE_PATH || '/synology/chat/outgoing';
const VERIFY_TOKEN = (process.env.SYNCHAT_OUTGOING_TOKEN || '').trim();
const INCOMING_URL = (process.env.SYNCHAT_INCOMING_URL || '').trim();
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CODEX_WORKDIR = process.env.CODEX_WORKDIR || '/home/codex/workspace';
const DOWNLOADS_DIR = path.join(CODEX_WORKDIR, 'Downloads');
const UPLOADS_DIR = path.join(CODEX_WORKDIR, 'Uploads');

const CODEX_MODEL = (process.env.CODEX_MODEL || '').trim();
const CODEX_DEFAULT_PROFILE = (process.env.CODEX_DEFAULT_PROFILE || '').trim();
const CODEX_ENABLE_PLANNER = String(process.env.CODEX_ENABLE_PLANNER || 'false').toLowerCase() === 'true';
const CODEX_PLANNER_PROFILE = (process.env.CODEX_PLANNER_PROFILE || 'qwen35').trim();
const CODEX_EXECUTOR_PROFILE = (process.env.CODEX_EXECUTOR_PROFILE || 'qwen36').trim();
const CODEX_PLANNER_MODEL = (process.env.CODEX_PLANNER_MODEL || '').trim();
const CODEX_EXECUTOR_MODEL = (process.env.CODEX_EXECUTOR_MODEL || '').trim();
const CODEX_SANDBOX_MODE = (process.env.CODEX_SANDBOX_MODE || 'workspace-write').trim();
const CODEX_BYPASS_SANDBOX = String(process.env.CODEX_BYPASS_SANDBOX || 'false').toLowerCase() === 'true';
const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS || 600000);
const CODEX_STALE_TIMEOUT_MS = Number(process.env.CODEX_STALE_TIMEOUT_MS || 60000);
const CODEX_HEARTBEAT_INTERVAL_MS = Number(process.env.CODEX_HEARTBEAT_INTERVAL_MS || 30000);
const CODEX_PLANNER_TIMEOUT_MS = Number(process.env.CODEX_PLANNER_TIMEOUT_MS || 90000);
const CODEX_EXECUTOR_TIMEOUT_MS = Number(process.env.CODEX_EXECUTOR_TIMEOUT_MS || CODEX_TIMEOUT_MS);
const CODEX_PLANNER_MAX_STEPS = Math.max(1, Math.min(Number(process.env.CODEX_PLANNER_MAX_STEPS || 6), 10));
const CODEX_INTENT_PROFILE = (process.env.CODEX_INTENT_PROFILE || 'qwen35').trim();
const CODEX_INTENT_MODEL = (process.env.CODEX_INTENT_MODEL || '').trim();
const CODEX_INTENT_TIMEOUT_MS = Number(process.env.CODEX_INTENT_TIMEOUT_MS || 30000);
const MAX_REPLY_CHARS = Number(process.env.MAX_REPLY_CHARS || 1800);
const SYSTEM_PROMPT = (process.env.CODEX_SYSTEM_PROMPT || '').trim();
const SCHEDULE_SEMANTIC_ENABLE = String(process.env.SCHEDULE_SEMANTIC_ENABLE || 'true').toLowerCase() === 'true';
const SCHEDULE_SEMANTIC_MIN_CONFIDENCE = Number(process.env.SCHEDULE_SEMANTIC_MIN_CONFIDENCE || 0.8);

// Ollama Vision 配置
const VISION_MODEL = process.env.VISION_MODEL || 'qwen2-vl';
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://127.0.0.1:11434';

const MEMORY_ENABLE = String(process.env.MEMORY_ENABLE || 'false');
const MEMORY_BACKEND = process.env.MEMORY_BACKEND || 'qdrant';
const MEMORY_PROJECT = process.env.MEMORY_PROJECT || 'codex_worker';
const MEMORY_TOP_K = Number(process.env.MEMORY_TOP_K || 5);
const QDRANT_URL = process.env.QDRANT_URL || 'http://qdrant:6333';
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'codex_memory';
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || 1536);
const MEMORY_SCORE_THRESHOLD = Number(process.env.MEMORY_SCORE_THRESHOLD || 0.35);
const MEMORY_SHORT_TTL_DAYS = Number(process.env.MEMORY_SHORT_TTL_DAYS || 14);
const MEMORY_FALLBACK_FILE = process.env.MEMORY_FALLBACK_FILE || '/home/codex/.codex/memory/fallback.jsonl';

const CHAT_CONTEXT_ENABLE = String(process.env.CHAT_CONTEXT_ENABLE || 'true');
const CHAT_CONTEXT_DB_PATH = process.env.CHAT_CONTEXT_DB_PATH || '/home/codex/.codex/chat_context/context.sqlite';
const CHAT_CONTEXT_MAX_MESSAGES = Number(process.env.CHAT_CONTEXT_MAX_MESSAGES || 10);

const TASK_CONCURRENCY = Math.max(1, Math.min(Number(process.env.TASK_CONCURRENCY || 2), 8));
const TASK_QUEUE_MAX = Math.max(10, Math.min(Number(process.env.TASK_QUEUE_MAX || 200), 5000));

const SCHEDULER_ENABLE = String(process.env.SCHEDULER_ENABLE || 'false');
const SCHEDULER_DB_PATH = process.env.SCHEDULER_DB_PATH || '/home/codex/.codex/scheduler/jobs.sqlite';
const AUTH_DB_PATH = process.env.AUTH_DB_PATH || '/home/codex/.codex/auth/fido.sqlite';
const CODEX_CHAT_SESSION_DB_PATH = process.env.CODEX_CHAT_SESSION_DB_PATH || '/home/codex/.codex/codex_chat/sessions.sqlite';
const SCHEDULER_TICK_SECONDS = Number(process.env.SCHEDULER_TICK_SECONDS || 30);
const SCHEDULER_CLAIM_LIMIT = Number(process.env.SCHEDULER_CLAIM_LIMIT || 3);
const SYSTEM_TIMEZONE = process.env.TZ || 'Asia/Taipei';
const SCHEDULER_TIMEZONE = process.env.SCHEDULER_DEFAULT_TIMEZONE || SYSTEM_TIMEZONE;
const SCHEDULER_MAX_RETRIES = Number(process.env.SCHEDULER_MAX_RETRIES || 3);
const SCHEDULER_RETRY_BASE_SECONDS = Number(process.env.SCHEDULER_RETRY_BASE_SECONDS || 60);
const SCHEDULER_ALLOWED_USERS = process.env.SCHEDULER_ALLOWED_USERS || '';
const SCHEDULER_ALLOWED_CHANNELS = process.env.SCHEDULER_ALLOWED_CHANNELS || '';
const SCHEDULER_ADMIN_USERS = process.env.SCHEDULER_ADMIN_USERS || '';
const SCHEDULER_MAX_ACTIVE_PER_USER = Number(process.env.SCHEDULER_MAX_ACTIVE_PER_USER || 10);
const SCHEDULER_MAX_ACTIVE_PER_CHANNEL = Number(process.env.SCHEDULER_MAX_ACTIVE_PER_CHANNEL || 50);
const SCHEDULER_RETENTION_DAYS = Number(process.env.SCHEDULER_RETENTION_DAYS || 30);
const SCHEDULER_CLEANUP_SECONDS = Number(process.env.SCHEDULER_CLEANUP_SECONDS || 3600);

const ADMIN_UI_ENABLE = String(process.env.ADMIN_UI_ENABLE || 'true');
const ADMIN_UI_PATH = process.env.ADMIN_UI_PATH || '/admin';
const ADMIN_UI_MEMORY_LIMIT = Number(process.env.ADMIN_UI_MEMORY_LIMIT || 50);
const ADMIN_UI_SCHEDULE_LIMIT = Number(process.env.ADMIN_UI_SCHEDULE_LIMIT || 100);
const ADMIN_AUTH_TOKEN = (process.env.ADMIN_AUTH_TOKEN || '').trim();
const ADMIN_UI_RP_ID = process.env.ADMIN_UI_RP_ID || 'localhost';
const ADMIN_UI_ORIGIN = process.env.ADMIN_UI_ORIGIN || `http://${ADMIN_UI_RP_ID}:8090`;

const APP_SERVER_TOKEN_FILE = process.env.APP_SERVER_TOKEN_FILE || '/home/codex/.codex/app-server-token';
const APP_SERVER_WS_URL = process.env.APP_SERVER_WS_URL || 'ws://127.0.0.1:9090';
const CODEX_ARCHIVED_SESSIONS_DIR = process.env.CODEX_ARCHIVED_SESSIONS_DIR || '/home/codex/.codex/sessions';

const DEFAULT_CHAT_ID = (process.env.DEFAULT_CHAT_ID || '').trim();
const SYNCHAT_FILE_URL_BASE = (process.env.SYNCHAT_FILE_URL_BASE || '').trim();

function parseCsvSet(s) {
  return new Set(
    String(s || '')
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
  );
}

const allowedUsersSet = parseCsvSet(SCHEDULER_ALLOWED_USERS);
const allowedChannelsSet = parseCsvSet(SCHEDULER_ALLOWED_CHANNELS);
const adminUsersSet = parseCsvSet(SCHEDULER_ADMIN_USERS);

module.exports = {
  PORT,
  PATHNAME,
  VERIFY_TOKEN,
  INCOMING_URL,
  CODEX_BIN,
  CODEX_WORKDIR,
  DOWNLOADS_DIR,
  UPLOADS_DIR,
  CODEX_MODEL,
  CODEX_DEFAULT_PROFILE,
  CODEX_ENABLE_PLANNER,
  CODEX_PLANNER_PROFILE,
  CODEX_EXECUTOR_PROFILE,
  CODEX_PLANNER_MODEL,
  CODEX_EXECUTOR_MODEL,
  CODEX_SANDBOX_MODE,
  CODEX_BYPASS_SANDBOX,
  CODEX_TIMEOUT_MS,
  CODEX_STALE_TIMEOUT_MS,
  CODEX_HEARTBEAT_INTERVAL_MS,
  CODEX_PLANNER_TIMEOUT_MS,
  CODEX_EXECUTOR_TIMEOUT_MS,
  CODEX_PLANNER_MAX_STEPS,
  CODEX_INTENT_PROFILE,
  CODEX_INTENT_MODEL,
  CODEX_INTENT_TIMEOUT_MS,
  MAX_REPLY_CHARS,
  SYSTEM_PROMPT,
  SCHEDULE_SEMANTIC_ENABLE,
  SCHEDULE_SEMANTIC_MIN_CONFIDENCE,
  VISION_MODEL,
  OLLAMA_API_URL,
  MEMORY_ENABLE,
  MEMORY_BACKEND,
  MEMORY_PROJECT,
  MEMORY_TOP_K,
  QDRANT_URL,
  QDRANT_COLLECTION,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  MEMORY_SCORE_THRESHOLD,
  MEMORY_SHORT_TTL_DAYS,
  MEMORY_FALLBACK_FILE,
  CHAT_CONTEXT_ENABLE,
  CHAT_CONTEXT_DB_PATH,
  CHAT_CONTEXT_MAX_MESSAGES,
  TASK_CONCURRENCY,
  TASK_QUEUE_MAX,
  SCHEDULER_ENABLE,
  SCHEDULER_DB_PATH,
  AUTH_DB_PATH,
  CODEX_CHAT_SESSION_DB_PATH,
  SCHEDULER_TICK_SECONDS,
  SCHEDULER_CLAIM_LIMIT,
  SYSTEM_TIMEZONE,
  SCHEDULER_TIMEZONE,
  SCHEDULER_MAX_RETRIES,
  SCHEDULER_RETRY_BASE_SECONDS,
  SCHEDULER_ALLOWED_USERS,
  SCHEDULER_ALLOWED_CHANNELS,
  SCHEDULER_ADMIN_USERS,
  SCHEDULER_MAX_ACTIVE_PER_USER,
  SCHEDULER_MAX_ACTIVE_PER_CHANNEL,
  SCHEDULER_RETENTION_DAYS,
  SCHEDULER_CLEANUP_SECONDS,
  ADMIN_UI_ENABLE,
  ADMIN_UI_PATH,
  ADMIN_UI_MEMORY_LIMIT,
  ADMIN_UI_SCHEDULE_LIMIT,
  ADMIN_AUTH_TOKEN,
  ADMIN_UI_RP_ID,
  ADMIN_UI_ORIGIN,
  APP_SERVER_TOKEN_FILE,
  APP_SERVER_WS_URL,
  CODEX_ARCHIVED_SESSIONS_DIR,
  DEFAULT_CHAT_ID,
  SYNCHAT_FILE_URL_BASE,
  allowedUsersSet,
  allowedChannelsSet,
  adminUsersSet,
};
