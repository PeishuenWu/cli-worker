'use strict';

const { URL } = require('url');
const { PATHNAME, INCOMING_URL } = require('../config');
const { log } = require('../logger');
const { 
  sendJson, readBody, parseIncoming, isAuthorized, logIncomingSummary 
} = require('./server');
const { getMessageText, parseScheduleCommand, truncateReply } = require('../utils');
const { handleScheduleCommand } = require('../services/scheduler');
const { runPromptWithMemory } = require('../services/chat');
const { postToIncomingWebhook } = require('../services/webhook');
const { classifyScheduleIntent, extractScheduleCommand } = require('../services/intent_classifier');
const { enqueueTask } = require('../queue');
const state = require('../state');

function stripJsonFence(text) {
  return String(text || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
}

function normalizeInteractiveButtons(rawButtons) {
  if (!Array.isArray(rawButtons) || rawButtons.length === 0) return null;
  const buttons = rawButtons
    .map((button, index) => {
      if (!button || typeof button !== 'object') return null;
      const name = String(button.name || button.action_name || `btn_${index + 1}`).trim();
      const text = String(button.text || button.display_name || button.label || '').trim();
      const value = String(button.value || name).trim();
      const style = String(button.style || 'default').trim().toLowerCase();
      if (!name || !text || !value) return null;
      if (!['default', 'green', 'red'].includes(style)) return null;
      return { name, text, value, style };
    })
    .filter(Boolean)
    .slice(0, 5);
  return buttons.length > 0 ? buttons : null;
}

function parseInteractiveReply(output) {
  const raw = stripJsonFence(output);
  if (!raw.startsWith('{')) return null;

  try {
    const parsed = JSON.parse(raw);
    const replyMode = String(parsed.reply_mode || parsed.mode || '').trim().toLowerCase();
    if (!['buttons', 'interactive_reply'].includes(replyMode)) return null;

    const text = String(parsed.text || parsed.message || '').trim();
    const buttons = normalizeInteractiveButtons(parsed.buttons);
    if (!text || !buttons) return null;

    return {
      text,
      attachments: [{
        callback_id: `notify_${Date.now()}`,
        actions: buttons.map((button) => ({
          type: 'button',
          name: button.name,
          text: button.text,
          value: button.value,
          style: button.style,
        })),
      }],
    };
  } catch (_err) {
    return null;
  }
}

function formatInteractiveFallback(interactiveReply) {
  const lines = [interactiveReply.text, ''];
  for (const action of interactiveReply.attachments[0].actions) {
    lines.push(`- ${action.text} (${action.value})`);
  }
  return lines.join('\n');
}

async function generateChatReply(messageText, data, options = {}) {
  const scheduleCmd = parseScheduleCommand(messageText);
  if (scheduleCmd) {
    return handleScheduleCommand(scheduleCmd, data);
  }

  const semanticIntent = await classifyScheduleIntent(messageText, data);
  const semanticScheduleCmd = await extractScheduleCommand(messageText, data, semanticIntent);
  if (semanticScheduleCmd) {
    log(`semantic schedule intent matched: action=${semanticScheduleCmd.action}, confidence=${semanticIntent.confidence}`);
    return handleScheduleCommand(semanticScheduleCmd, data);
  }

  return runPromptWithMemory(messageText, data, 'synology_chat', options);
}

async function handleChatRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/internal/notify') {
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      sendJson(res, 403, { error: 'forbidden_remote' });
      return;
    }
    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody);
      const { text, channel_id, user_id, attachments, filePath } = payload;
      log(`Internal notify request: text="${text}", filePath="${filePath}"`);
      const targetUserId = user_id || state.lastActiveIds.user_id;
      const targetChannelId = channel_id || state.lastActiveIds.channel_id;
      await postToIncomingWebhook(text, {}, {
        channel_id: targetChannelId,
        user_id: targetUserId,
        attachments,
        filePath
      });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      log(`Internal notify failed: ${err.message}`);
      sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  if (req.method !== 'POST' || url.pathname !== PATHNAME) {
    return false; // Not handled
  }

  let parsed;
  try {
    const rawBody = await readBody(req);
    parsed = parseIncoming(req, rawBody);
    logIncomingSummary(req, parsed.data);
  } catch (err) {
    log(`Request parsing failed: ${err.message}`);
    sendJson(res, 400, { error: 'invalid_request', detail: err.message });
    return true;
  }

  const { data } = parsed;
  if (!isAuthorized(data, req.requestId)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return true;
  }

  const messageText = getMessageText(data);
  const hasFile = !!(data.file_id || data.file_ids || data.file_name);
  
  if (data.user_id || data.channel_id) {
    state.lastActiveIds.user_id = data.user_id || '';
    state.lastActiveIds.channel_id = data.channel_id || '';
  }
  
  if (!messageText && !hasFile) {
    sendJson(res, 200, { text: '請輸入要給 Codex 的內容或上傳檔案。' });
    return true;
  }

  if (INCOMING_URL) {
    sendJson(res, 200, { text: '已收到，Codex 產生回覆中。' });
    const enqueued = enqueueTask(async () => {
      try {
        log('processing async request from', data.username || data.user_name || 'unknown');
        const output = await generateChatReply(messageText, data, {
          onProgress: (elapsedMs) => {
            const seconds = Math.floor(elapsedMs / 1000);
            postToIncomingWebhook(`Codex 正在處理您的請求，請稍候... (已執行 ${seconds} 秒)`, data).catch((e) => {
              log('heartbeat failed:', e.message);
            });
          }
        });
        const interactiveReply = parseInteractiveReply(output);
        if (interactiveReply) {
          log(`Async task generated interactive reply: "${interactiveReply.text.slice(0, 50)}..."`);
          await postToIncomingWebhook(interactiveReply.text, data, {
            attachments: interactiveReply.attachments,
          });
          return;
        }

        const reply = truncateReply(output);
        log(`Async task generated reply: "${reply.slice(0, 50)}..."`);
        await postToIncomingWebhook(reply, data);
      } catch (err) {
        log('async processing failed:', err.message);
        const errMsg = `Codex 執行失敗: ${truncateReply(err.message || 'unknown_error')}`;
        try {
          await postToIncomingWebhook(errMsg, data);
        } catch (postErr) {
          log('failed to send error back to incoming webhook:', postErr.message);
        }
      }
    }, 'incoming_chat');
    if (!enqueued.ok) {
      const errMsg = `系統忙碌中（queue_backpressure），請稍後再試。`;
      postToIncomingWebhook(errMsg, data).catch((postErr) => {
        log('failed to send queue backpressure message:', postErr.message);
      });
    }
    return true;
  }

  try {
    const output = await generateChatReply(messageText, data);
    const interactiveReply = parseInteractiveReply(output);
    if (interactiveReply) {
      sendJson(res, 200, { text: formatInteractiveFallback(interactiveReply) });
      return true;
    }
    sendJson(res, 200, { text: truncateReply(output) });
  } catch (err) {
    const prefix = parseScheduleCommand(messageText) ? '排程處理失敗' : 'Codex 執行失敗';
    sendJson(res, 500, { text: `${prefix}: ${truncateReply(err.message || 'unknown_error')}` });
  }
  return true;
}

module.exports = {
  handleChatRequest,
};
