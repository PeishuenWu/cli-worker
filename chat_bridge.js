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
const { runPrecheck } = require('./src/services/precheck');

async function main() {
  // 1. Run Pre-check
  await runPrecheck();

  // 2. Initialize Stores
  await chatContextStore.init().then(() => {
    if (CHAT_CONTEXT_ENABLE === 'true') {
      log(`chat context enabled, db=${CHAT_CONTEXT_DB_PATH}, max_messages=${CHAT_CONTEXT_MAX_MESSAGES}`);
    } else {
      log('chat context disabled');
    }
  }).catch((err) => {
    log('chat context init fatal:', err.message);
  });

  await memoryStore.init(log).catch((err) => {
    log('memory init fatal:', err.message);
  });

  await schedulerStore.init().then(() => {
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

  // 3. Start the Server
  const server = startServer(handleChatRequest);

  // 4. Graceful Shutdown
  const gracefulShutdown = (signal) => {
    log(`Received ${signal}, starting graceful shutdown...`);
    server.close(() => {
      log('HTTP server closed.');
      // Add more cleanup here if needed (e.g., closing DB connections if they are persistent)
      process.exit(0);
    });

    // Force shutdown if taking too long
    setTimeout(() => {
      log('Could not close connections in time, forceful shutdown');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

main().catch((err) => {
  log('fatal error in main:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log('Unhandled Rejection at:', promise, 'reason:', reason);
});
