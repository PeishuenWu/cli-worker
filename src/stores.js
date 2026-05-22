'use strict';

const { MemoryStore, buildMemoryContext, buildMemoryEntry } = require('../memory_store');
const { SchedulerStore } = require('../scheduler_store');
const { ChatContextStore } = require('../chat_context_store');
const { AuthStore } = require('./stores/auth_store');
const {
  MEMORY_ENABLE, MEMORY_BACKEND, MEMORY_PROJECT, MEMORY_TOP_K, 
  MEMORY_SCORE_THRESHOLD, MEMORY_SHORT_TTL_DAYS, QDRANT_URL, 
  QDRANT_COLLECTION, OPENAI_API_KEY, OPENAI_BASE_URL, EMBEDDING_MODEL, 
  EMBEDDING_DIM, MEMORY_FALLBACK_FILE,
  SCHEDULER_ENABLE, SCHEDULER_DB_PATH,
  CHAT_CONTEXT_ENABLE, CHAT_CONTEXT_DB_PATH, CHAT_CONTEXT_MAX_MESSAGES,
  AUTH_DB_PATH
} = require('./config');

const memoryStore = new MemoryStore({
  enabled: MEMORY_ENABLE,
  backend: MEMORY_BACKEND,
  project: MEMORY_PROJECT,
  topK: MEMORY_TOP_K,
  scoreThreshold: MEMORY_SCORE_THRESHOLD,
  shortTtlDays: MEMORY_SHORT_TTL_DAYS,
  qdrantUrl: QDRANT_URL,
  collection: QDRANT_COLLECTION,
  embeddingApiKey: OPENAI_API_KEY,
  embeddingBaseUrl: OPENAI_BASE_URL,
  embeddingModel: EMBEDDING_MODEL,
  embeddingDim: EMBEDDING_DIM,
  fallbackFile: MEMORY_FALLBACK_FILE,
});

const schedulerStore = new SchedulerStore({
  enabled: SCHEDULER_ENABLE,
  dbPath: SCHEDULER_DB_PATH,
});

const chatContextStore = new ChatContextStore({
  enabled: CHAT_CONTEXT_ENABLE,
  dbPath: CHAT_CONTEXT_DB_PATH,
  maxMessagesPerChannel: CHAT_CONTEXT_MAX_MESSAGES,
});

const authStore = new AuthStore({
  dbPath: AUTH_DB_PATH,
});

module.exports = {
  memoryStore,
  schedulerStore,
  chatContextStore,
  authStore,
  buildMemoryContext,
  buildMemoryEntry,
};
