'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const querystring = require('querystring');
const { 
  INCOMING_URL, DOWNLOADS_DIR, UPLOADS_DIR, SYNCHAT_FILE_URL_BASE, DEFAULT_CHAT_ID
} = require('../config');
const { log } = require('../logger');
const { sanitizeFileName } = require('../utils');
const { lastActiveIds } = require('../state');

async function fetchUrlContent(urlString) {
  if (!urlString) return '';
  try {
    const url = new URL(urlString);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          if (data.length > 1024 * 256) { // limit 256KB
            res.destroy();
          }
        });
        res.on('end', () => {
          let text = data
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          resolve(text.slice(0, 10000));
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
  } catch (err) {
    log(`fetchUrlContent error for ${urlString}:`, err.message);
    return '';
  }
}

function getApiToken() {
  if (!INCOMING_URL) return '';
  try {
    const url = new URL(INCOMING_URL);
    return url.searchParams.get('token') || '';
  } catch (err) {
    return '';
  }
}

async function fetchFilesByPostId(postId, fileName) {
  let apiToken = getApiToken();
  if (!postId || !apiToken || !INCOMING_URL) {
    log('fetchFilesByPostId skipped: missing postId, token or INCOMING_URL');
    return [];
  }

  if (!apiToken.startsWith('"')) apiToken = `"${apiToken}"`;

  try {
    const incomingUrl = new URL(INCOMING_URL);
    const downloadUrl = new URL(`${incomingUrl.protocol}//${incomingUrl.host}${incomingUrl.pathname}`);
    downloadUrl.searchParams.set('api', 'SYNO.Chat.External');
    downloadUrl.searchParams.set('method', 'post_file_get');
    downloadUrl.searchParams.set('version', '2');
    downloadUrl.searchParams.set('post_id', postId);
    downloadUrl.searchParams.set('token', apiToken);

    log(`fetchFilesByPostId: Downloading attachment for post_id=${postId}`);
    
    const result = await new Promise((resolve, reject) => {
      const client = downloadUrl.protocol === 'https:' ? https : http;
      client.get(downloadUrl.toString(), { timeout: 30000 }, (res) => {
        const contentType = res.headers['content-type'] || '';
        
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            resolve(`[下載失敗: HTTP ${res.statusCode}, 內容: ${body.slice(0, 50).replace(/\0/g, '')}]`);
          });
          return;
        }

        if (contentType.includes('application/json')) {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (json.success === false) {
                resolve(`[API 報錯: ${JSON.stringify(json.error)}]`);
              } else {
                resolve(`[API 回傳 JSON 資料，非直接內容]`);
              }
            } catch (e) {
              resolve(`[JSON 解析失敗]`);
            }
          });
          return;
        }

        let actualFileName = sanitizeFileName(fileName || `file_${postId}`);
        let filePath = path.resolve(UPLOADS_DIR, actualFileName);
        const baseDir = path.resolve(UPLOADS_DIR) + path.sep;
        if (!filePath.startsWith(baseDir)) {
          resolve('[檔名不合法，已拒絕寫入]');
          return;
        }

        if (fs.existsSync(filePath)) {
          const ext = path.extname(actualFileName);
          const base = path.basename(actualFileName, ext);
          const timestamp = Math.floor(Date.now() / 1000);
          actualFileName = `${base}_${timestamp}${ext}`;
          filePath = path.resolve(UPLOADS_DIR, actualFileName);
          log(`File collision detected, renamed to: ${actualFileName}`);
        }

        const fileStream = fs.createWriteStream(filePath);
        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          log(`fetchFilesByPostId: Successfully saved ${actualFileName} (${contentType})`);
          resolve(`[附件檔案已下載並存至 ${path.join('Uploads', actualFileName)}，檔案類型: ${contentType}]`);
        });

        fileStream.on('error', (err) => {
          fileStream.destroy();
          resolve(`[檔案寫入失敗: ${err.message}]`);
        });
      }).on('error', (err) => {
        reject(err);
      });
    });

    return [result];
  } catch (err) {
    log(`fetchFilesByPostId fatal error: ${err.message}`);
    return [`[無法獲取檔案: ${err.message}]`];
  }
}

function postToIncomingWebhook(text, data = {}, options = {}) {
  if (!INCOMING_URL) return Promise.resolve();

  const url = new URL(INCOMING_URL);
  const isChatbot = url.searchParams.get('method') === 'chatbot';
  
  const payload = { text };
  if (options.attachments) {
    payload.attachments = options.attachments;
  }

  let effectivePath = options.filePath;
  if (effectivePath && !fs.existsSync(effectivePath)) {
    const filename = path.basename(effectivePath);
    const fallbackPath = path.join(DOWNLOADS_DIR, filename);
    if (fs.existsSync(fallbackPath)) {
      effectivePath = fallbackPath;
      log(`postToIncomingWebhook: File not found at original path, found fallback in Downloads: ${effectivePath}`);
    }
  }

  if (effectivePath && fs.existsSync(effectivePath)) {
    const filename = path.basename(effectivePath);
    const targetPath = path.join(DOWNLOADS_DIR, filename);
    
    if (path.resolve(effectivePath) !== path.resolve(targetPath)) {
      try {
        fs.copyFileSync(effectivePath, targetPath);
        log(`postToIncomingWebhook: Copied file to ${targetPath}`);
      } catch (err) {
        log(`postToIncomingWebhook: Failed to copy file: ${err.message}`);
      }
    }

    if (SYNCHAT_FILE_URL_BASE) {
      payload.file_url = `${SYNCHAT_FILE_URL_BASE}/files/${encodeURIComponent(filename)}`;
      log(`postToIncomingWebhook: Using file_url: ${payload.file_url}`);
    } else {
      log(`postToIncomingWebhook Warning: filePath provided but SYNCHAT_FILE_URL_BASE is not set. File will not be sent.`);
    }
  }
  
  if (isChatbot) {
    const rawUserId = options.user_id || data.user_id || lastActiveIds.user_id;
    const rawChannelId = options.channel_id || data.channel_id || lastActiveIds.channel_id;
    
    let targetUserId = parseInt(rawUserId, 10);
    let targetChannelId = parseInt(rawChannelId, 10);

    if ((isNaN(targetUserId) || targetUserId <= 0) && (isNaN(targetChannelId) || targetChannelId <= 0) && DEFAULT_CHAT_ID) {
      if (/^\d+$/.test(DEFAULT_CHAT_ID)) {
        targetChannelId = parseInt(DEFAULT_CHAT_ID, 10);
        log(`postToIncomingWebhook: Using DEFAULT_CHAT_ID: ${targetChannelId}`);
      }
    }

    if (!isNaN(targetUserId) && targetUserId > 0) {
      payload.user_ids = [targetUserId];
    } else if (!isNaN(targetChannelId) && targetChannelId > 0) {
      payload.channel_id = targetChannelId;
    } else {
      log(`postToIncomingWebhook Warning: No valid ID. rawUserId=${rawUserId}, rawChannelId=${rawChannelId}, lastActiveIds=${JSON.stringify(lastActiveIds)}`);
    }
  }

  const body = querystring.stringify({
    payload: JSON.stringify(payload),
  });

  const httpOptions = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    log(`postToIncomingWebhook: Sending to ${url.origin}${url.pathname}. Payload: ${JSON.stringify(payload)}`);
    const req = client.request(httpOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          log(`postToIncomingWebhook: Success (HTTP ${res.statusCode})`);
          resolve(data);
          return;
        }
        log(`postToIncomingWebhook: Failed (HTTP ${res.statusCode}): ${data}`);
        reject(new Error(`incoming_webhook_http_${res.statusCode}: ${data}`));
      });
    });

    req.on('error', (err) => {
      log(`postToIncomingWebhook: Request Error: ${err.message}`);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

module.exports = {
  fetchUrlContent,
  getApiToken,
  fetchFilesByPostId,
  postToIncomingWebhook,
};
