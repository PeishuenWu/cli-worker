#!/usr/bin/env node
'use strict';

const { 
  CHAT_CONTEXT_ENABLE, CHAT_CONTEXT_DB_PATH, CHAT_CONTEXT_MAX_MESSAGES,
  SCHEDULER_ENABLE, SCHEDULER_DB_PATH, SCHEDULER_TICK_SECONDS, 
  SCHEDULER_TIMEZONE, SCHEDULER_CLEANUP_SECONDS,
  allowedUsersSet, allowedChannelsSet, adminUsersSet
} = require('./src/config');
const { log } = require('./src/logger');
const { chatContextStore, memoryStore, schedulerStore } = require('./src/stores');
const { runSchedulerTick, runSchedulerCleanup } = require('./src/services/scheduler');
const { handleChatRequest } = require('./src/api/chat');
const { startServer } = require('./src/api/server');

// Initialize Chat Context Store
chatContextStore.init().then(() => {
  if (CHAT_CONTEXT_ENABLE === 'true') {
    log(`chat context enabled, db=${CHAT_CONTEXT_DB_PATH}, max_messages=${CHAT_CONTEXT_MAX_MESSAGES}`);
  } else {
    log('chat context disabled');
  }
}).catch((err) => {
  log('chat context init fatal:', err.message);
});

// Initialize Memory Store
memoryStore.init(log).catch((err) => {
  log('memory init fatal:', err.message);
});

// Initialize Scheduler and Background Workers
schedulerStore.init().then(() => {
  if (String(SCHEDULER_ENABLE) !== 'true') {
    log('scheduler disabled');
    return;
  }
  log(`scheduler enabled, db=${SCHEDULER_DB_PATH}, tick=${SCHEDULER_TICK_SECONDS}s, timezone=${SCHEDULER_TIMEZONE}`);
  log(`scheduler acl users=${allowedUsersSet.size} channels=${allowedChannelsSet.size} admins=${adminUsersSet.size}`);
  
  // First run
  runSchedulerTick().catch((err) => {
    log('scheduler first tick failed:', err.message);
  });
  runSchedulerCleanup().catch((err) => {
    log('scheduler first cleanup failed:', err.message);
  });

  // Ticks
  setInterval(() => {
    runSchedulerTick().catch((err) => {
      log('scheduler tick failed:', err.message);
    });
  }, Math.max(5, SCHEDULER_TICK_SECONDS) * 1000);

  // Cleanup
  setInterval(() => {
    runSchedulerCleanup().catch((err) => {
      log('scheduler cleanup interval failed:', err.message);
    });
  }, Math.max(300, SCHEDULER_CLEANUP_SECONDS) * 1000);
}).catch((err) => {
  log('scheduler init fatal:', err.message);
});

// Start the Server
startServer(handleChatRequest);

process.on('unhandledRejection', (reason, promise) => {
  log('Unhandled Rejection at:', promise, 'reason:', reason);
});
