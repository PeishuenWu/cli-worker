'use strict';

const {
  CODEX_INTENT_PROFILE,
  CODEX_INTENT_MODEL,
  CODEX_INTENT_TIMEOUT_MS,
  SCHEDULE_SEMANTIC_ENABLE,
  SCHEDULE_SEMANTIC_MIN_CONFIDENCE,
  SCHEDULER_TIMEZONE,
} = require('../config');
const { log } = require('../logger');
const { runCodex } = require('./codex');

function parseJsonObject(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return JSON.parse(text);
}

function normalizeAction(action) {
  const value = String(action || '').trim().toLowerCase();
  const allowed = new Set([
    'none',
    'help',
    'list',
    'cancel',
    'pause',
    'resume',
    'create_at',
    'create_cron',
  ]);
  return allowed.has(value) ? value : 'none';
}

function normalizeConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function buildClassifierPrompt(messageText, data) {
  const username = String(data.username || data.user_name || data.user || '').trim() || 'unknown';
  return [
    '你是任務分類器，只負責判斷使用者是否要你現在執行排程操作。',
    '只輸出 JSON，不要 markdown，不要解釋。',
    '如果使用者是在詢問教學、解釋、範例、程式碼、概念，action 必須是 "none"。',
    '只有在使用者明確要求建立、查詢、暫停、恢復、取消排程時，才可判為排程意圖。',
    'JSON schema: {"action":"none|help|list|cancel|pause|resume|create_at|create_cron","confidence":number,"reason":string}',
    `時區預設: ${SCHEDULER_TIMEZONE}`,
    `使用者: ${username}`,
    `訊息: ${String(messageText || '').trim()}`,
  ].join('\n');
}

function buildExtractorPrompt(messageText, data, intentAction) {
  const username = String(data.username || data.user_name || data.user || '').trim() || 'unknown';
  return [
    '你是排程參數抽取器，只負責把使用者意圖轉成既有排程命令。',
    '只輸出 JSON，不要 markdown，不要額外說明。',
    '若無法安全抽取必要欄位，請輸出 action="none"。',
    '對 create_at：runAtInput 必須是 YYYY-MM-DD HH:MM，且應盡量轉成絕對日期時間。',
    '對 create_cron：cronExpr 必須是標準 5 欄位 m h dom mon dow。',
    '對 cancel/pause/resume：id 必須是正整數。',
    '對 list/help：不需要其他欄位。',
    '如果訊息是在詢問說明、文件、範例，而不是要求立即操作，請輸出 action="none"。',
    'JSON schema: {"action":"none|help|list|cancel|pause|resume|create_at|create_cron","confidence":number,"prompt":string,"runAtInput":string,"cronExpr":string,"id":number}',
    `時區預設: ${SCHEDULER_TIMEZONE}`,
    `預判 action: ${intentAction}`,
    `使用者: ${username}`,
    `訊息: ${String(messageText || '').trim()}`,
  ].join('\n');
}

async function classifyScheduleIntent(messageText, data) {
  if (!SCHEDULE_SEMANTIC_ENABLE) {
    return { enabled: false, action: 'none', confidence: 0, reason: 'semantic_schedule_disabled' };
  }

  try {
    const raw = await runCodex(buildClassifierPrompt(messageText, data), {
      CODEX_CURRENT_USER_ID: String(data.user_id || ''),
      CODEX_CURRENT_CHANNEL_ID: String(data.channel_id || ''),
    }, {
      profile: CODEX_INTENT_PROFILE,
      model: CODEX_INTENT_MODEL,
      timeoutMs: CODEX_INTENT_TIMEOUT_MS,
      metadataTag: 'schedule-intent-classifier',
    });
    const parsed = parseJsonObject(raw);
    const action = normalizeAction(parsed.action);
    const confidence = normalizeConfidence(parsed.confidence);
    return {
      enabled: true,
      action,
      confidence,
      reason: String(parsed.reason || '').trim(),
    };
  } catch (err) {
    log(`semantic schedule classifier failed: ${err.message}`);
    return { enabled: true, action: 'none', confidence: 0, reason: 'classifier_failed' };
  }
}

async function extractScheduleCommand(messageText, data, intent) {
  if (!intent || intent.action === 'none' || intent.confidence < SCHEDULE_SEMANTIC_MIN_CONFIDENCE) {
    return null;
  }

  try {
    const raw = await runCodex(buildExtractorPrompt(messageText, data, intent.action), {
      CODEX_CURRENT_USER_ID: String(data.user_id || ''),
      CODEX_CURRENT_CHANNEL_ID: String(data.channel_id || ''),
    }, {
      profile: CODEX_INTENT_PROFILE,
      model: CODEX_INTENT_MODEL,
      timeoutMs: CODEX_INTENT_TIMEOUT_MS,
      metadataTag: 'schedule-intent-extractor',
    });
    const parsed = parseJsonObject(raw);
    const action = normalizeAction(parsed.action || intent.action);
    const confidence = normalizeConfidence(parsed.confidence || intent.confidence);
    if (action === 'none' || confidence < SCHEDULE_SEMANTIC_MIN_CONFIDENCE) {
      return null;
    }

    if (action === 'list' || action === 'help') return { action };

    if (action === 'cancel' || action === 'pause' || action === 'resume') {
      const id = Number(parsed.id);
      if (!Number.isInteger(id) || id <= 0) return null;
      return { action, id };
    }

    if (action === 'create_at') {
      const runAtInput = String(parsed.runAtInput || '').trim();
      const prompt = String(parsed.prompt || '').trim();
      if (!runAtInput || !prompt) return null;
      return { action, runAtInput, prompt };
    }

    if (action === 'create_cron') {
      const cronExpr = String(parsed.cronExpr || '').trim();
      const prompt = String(parsed.prompt || '').trim();
      if (!cronExpr || !prompt) return null;
      return { action, cronExpr, prompt };
    }

    return null;
  } catch (err) {
    log(`semantic schedule extractor failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  classifyScheduleIntent,
  extractScheduleCommand,
};
