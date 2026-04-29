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
const { enqueueTask } = require('../queue');
const state = require('../state');

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
  if (!isAuthorized(data)) {
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

  const scheduleCmd = parseScheduleCommand(messageText);
  if (scheduleCmd) {
    try {
      const text = await handleScheduleCommand(scheduleCmd, data);
      sendJson(res, 200, { text });
    } catch (err) {
      sendJson(res, 500, { text: `排程處理失敗: ${truncateReply(err.message || 'unknown_error')}` });
    }
    return true;
  }

  if (INCOMING_URL) {
    sendJson(res, 200, { text: '已收到，Codex 產生回覆中。' });
    const enqueued = enqueueTask(async () => {
      try {
        log('processing async request from', data.username || data.user_name || 'unknown');
        const output = await runPromptWithMemory(messageText, data, 'synology_chat', {
          onProgress: (elapsedMs) => {
            const seconds = Math.floor(elapsedMs / 1000);
            postToIncomingWebhook(`Codex 正在處理您的請求，請稍候... (已執行 ${seconds} 秒)`, data).catch((e) => {
              log('heartbeat failed:', e.message);
            });
          }
        });
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
    const output = await runPromptWithMemory(messageText, data, 'synology_chat');
    sendJson(res, 200, { text: truncateReply(output) });
  } catch (err) {
    sendJson(res, 500, { text: `Codex 執行失敗: ${truncateReply(err.message || 'unknown_error')}` });
  }
  return true;
}

module.exports = {
  handleChatRequest,
};
