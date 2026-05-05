'use strict';

const { MAX_REPLY_CHARS } = require('./config');
const { log } = require('./logger');

function parseCookies(cookieHeader) {
  const raw = String(cookieHeader || '');
  const map = {};
  if (!raw) return map;
  const parts = raw.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    map[key] = decodeURIComponent(value);
  }
  return map;
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function shortText(input, max = 120) {
  const s = String(input || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function fmtTs(input) {
  if (!input) return '-';
  try {
    const d = new Date(input);
    return d.toLocaleString('zh-TW', { hour12: false });
  } catch (err) {
    return String(input);
  }
}

function truncateReply(text) {
  if (!text) return 'Codex 沒有輸出內容。';
  if (text.length <= MAX_REPLY_CHARS) return text;
  return `${text.slice(0, MAX_REPLY_CHARS)}\n...(已截斷)`;
}

function getMessageText(data) {
  if (data.action_name) {
    return `[使用者點擊了互動按鈕: ${data.action_name}, 數值: ${data.action_value}, Callback ID: ${data.callback_id}]`;
  }
  if (Array.isArray(data.actions) && data.actions.length > 0) {
    const action = data.actions[0];
    return `[使用者點擊了互動按鈕: ${action.name || action.action_name}, 數值: ${action.value || action.action_value}, Callback ID: ${data.callback_id}]`;
  }
  const text = String(data.text || '').trim();
  const triggerWord = String(data.trigger_word || '').trim();
  if (!text) return '';
  if (!triggerWord) return text;
  const lowerText = text.toLowerCase();
  const lowerTrigger = triggerWord.toLowerCase();
  if (lowerText.startsWith(lowerTrigger)) {
    return text.slice(triggerWord.length).trim() || text;
  }
  return text;
}

function sanitizeFileName(input) {
  const path = require('path');
  const raw = String(input || '').trim();
  const base = path.basename(raw || 'file.bin');
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'file.bin').slice(0, 120);
}

function sanitizeText(input) {
  return String(input || '').replace(/\0/g, '').trim();
}

function isPrivateIp(ip) {
  if (!ip) return false;
  // Simple check for common private ranges
  return (
    ip.startsWith('10.') ||
    ip.startsWith('172.16.') || ip.startsWith('172.17.') || ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
    ip.startsWith('172.20.') || ip.startsWith('172.21.') || ip.startsWith('172.22.') || ip.startsWith('172.23.') ||
    ip.startsWith('172.24.') || ip.startsWith('172.25.') || ip.startsWith('172.26.') || ip.startsWith('172.27.') ||
    ip.startsWith('172.28.') || ip.startsWith('172.29.') || ip.startsWith('172.30.') || ip.startsWith('172.31.') ||
    ip.startsWith('192.168.') ||
    ip === '127.0.0.1' ||
    ip === 'localhost' ||
    ip === '::1'
  );
}

function isValidFetchUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const hostname = url.hostname.toLowerCase();
    if (isPrivateIp(hostname)) return false;
    // Further hostname checks could go here
    return true;
  } catch (err) {
    return false;
  }
}

function parseAtDateTime(input) {
  const s = String(input || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function parseCronField(field, min, max, allowSevenForDow = false) {
  const raw = String(field || '').trim();
  if (!raw) return null;
  const parts = raw.split(',');
  const values = new Set();
  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part) return null;
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) return null;
    let start;
    let end;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((x) => Number(x));
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      start = a;
      end = b;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return null;
      start = n;
      end = n;
    }
    if (allowSevenForDow && start === 7) start = 0;
    if (allowSevenForDow && end === 7) end = 0;
    if (start === 0 && end === 0 && rangePart.includes('-')) return null;
    if (start < min || start > max || end < min || end > max || start > end) return null;
    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }
  return values;
}

function parseCronExpression(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  const dow = parseCronField(parts[4], 0, 6, true);
  if (!minute || !hour || !dom || !month || !dow) return null;
  return {
    expr: parts.join(' '),
    minute,
    hour,
    dom,
    month,
    dow,
    domAny: parts[2] === '*',
    dowAny: parts[4] === '*',
  };
}

function cronMatches(parsed, d) {
  const m = d.getMinutes();
  const h = d.getHours();
  const day = d.getDate();
  const mon = d.getMonth() + 1;
  const dow = d.getDay();
  if (!parsed.minute.has(m)) return false;
  if (!parsed.hour.has(h)) return false;
  if (!parsed.month.has(mon)) return false;
  const domMatch = parsed.dom.has(day);
  const dowMatch = parsed.dow.has(dow);
  if (parsed.domAny && parsed.dowAny) return true;
  if (parsed.domAny) return dowMatch;
  if (parsed.dowAny) return domMatch;
  return domMatch || dowMatch;
}

function nextCronRunIso(parsed, fromDate = new Date()) {
  const d = new Date(fromDate.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (cronMatches(parsed, d)) return d.toISOString();
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

function parseScheduleCommand(messageText) {
  const m = String(messageText || '').trim().match(/^(schedule|排程)\s*(.+)$/i);
  if (!m) return null;
  const body = m[2].trim();
  if (/^(list|列表|清單)$/i.test(body)) return { action: 'list' };
  const cancelMatch = body.match(/^(cancel|取消|刪除)\s+(\d+)$/i);
  if (cancelMatch) return { action: 'cancel', id: Number(cancelMatch[2]) };
  const pauseMatch = body.match(/^(pause|暫停)\s+(\d+)$/i);
  if (pauseMatch) return { action: 'pause', id: Number(pauseMatch[2]) };
  const resumeMatch = body.match(/^(resume|恢復)\s+(\d+)$/i);
  if (resumeMatch) return { action: 'resume', id: Number(resumeMatch[2]) };
  const atMatch = body.match(/^(at|在)\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})\s+([\s\S]+)$/i);
  if (atMatch) {
    return {
      action: 'create_at',
      runAtInput: atMatch[2],
      prompt: atMatch[3].trim(),
    };
  }
  const cronMatch = body.match(/^(cron|週期)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/i);
  if (cronMatch) {
    return {
      action: 'create_cron',
      cronExpr: cronMatch[2].trim(),
      prompt: cronMatch[3].trim(),
    };
  }
  return null;
}

module.exports = {
  parseCookies,
  escapeHtml,
  shortText,
  fmtTs,
  truncateReply,
  getMessageText,
  sanitizeFileName,
  sanitizeText,
  isValidFetchUrl,
  parseAtDateTime,
  parseCronExpression,
  cronMatches,
  nextCronRunIso,
  parseScheduleCommand,
};
