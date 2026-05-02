#!/usr/bin/env node
'use strict';

const http = require('http');
const path = require('path');

const CHAT_BRIDGE_PORT = Number(process.env.CHAT_BRIDGE_PORT || 8090);

function log(...args) {
  console.log(new Date().toISOString(), '[NotifyTool]', ...args);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    text: '',
    file: '',
    buttons: null,
    channel: '',
    user: ''
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--text' && args[i + 1]) {
      params.text = args[++i];
    } else if (arg === '--file' && args[i + 1]) {
      params.file = args[++i];
    } else if (arg === '--buttons' && args[i + 1]) {
      try {
        params.buttons = JSON.parse(args[++i]);
      } catch (e) {
        log('Error parsing buttons JSON:', e.message);
      }
    } else if (arg === '--channel' && args[i + 1]) {
      params.channel = args[++i];
    } else if (arg === '--user' && args[i + 1]) {
      params.user = args[++i];
    }
  }

  return params;
}

async function sendNotify(params) {
  const payload = {
    text: params.text,
    filePath: params.file ? path.resolve(params.file) : undefined,
    attachments: params.buttons ? [{
      callback_id: `notify_${Date.now()}`,
      actions: params.buttons.map(b => ({
        type: 'button',
        name: b.name || 'btn',
        text: b.text || b.display_name || 'Button',
        value: b.value || 'val',
        style: b.style || 'default'
      }))
    }] : undefined,
    channel_id: params.channel || process.env.CODEX_CURRENT_CHANNEL_ID || undefined,
    user_id: params.user || process.env.CODEX_CURRENT_USER_ID || undefined
  };

  const body = JSON.stringify(payload);
  const options = {
    hostname: '127.0.0.1',
    port: CHAT_BRIDGE_PORT,
    path: '/internal/notify',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const params = parseArgs();
  
  if (!params.text && !params.file && !params.buttons) {
    console.log('Usage: node notify.js --text "msg" [--file "path"] [--buttons "json"] [--channel "id"] [--user "id"]');
    console.log('\n提示: 若在 Chatbot 模式下沒收到訊息，請確認是否提供了 --channel 或 --user。');
    console.log('您可以從 chat_bridge.js 的日誌中找到您的 user_id 或 channel_id。');
    process.exit(0);
  }

  try {
    const result = await sendNotify(params);
    if (result.ok) {
      console.log('通知傳送成功');
    } else {
      console.log('通知傳送失敗:', result.error);
    }
  } catch (err) {
    console.error('通知傳送發生錯誤:', err.message);
    process.exit(1);
  }
}

main();
