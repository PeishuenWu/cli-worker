'use strict';

const EventEmitter = require('events');
const eventEmitter = new EventEmitter();

const metrics = {
  started_at: new Date().toISOString(),
  scheduler_ticks_total: 0,
  scheduler_jobs_claimed_total: 0,
  scheduler_jobs_success_total: 0,
  scheduler_jobs_retry_total: 0,
  scheduler_jobs_failed_total: 0,
  scheduler_cleanup_runs_total: 0,
  scheduler_cleanup_deleted_total: 0,
  schedule_commands_total: 0,
  schedule_commands_denied_total: 0,
  task_queue_enqueued_total: 0,
  task_queue_rejected_total: 0,
  task_queue_completed_total: 0,
  task_queue_failed_total: 0,
};

const LOG_FORMAT = process.env.LOG_FORMAT || 'text'; // 'text' or 'json'

function log(msg, context = {}) {
  const timestamp = new Date().toISOString();
  const level = context.level || 'info';
  
  if (LOG_FORMAT === 'json') {
    const logObj = {
      timestamp,
      level,
      message: typeof msg === 'string' ? msg : JSON.stringify(msg),
      ...context
    };
    delete logObj.level;
    console.log(JSON.stringify({ level, ...logObj }));
  } else {
    const rid = context.requestId ? ` [${context.requestId}]` : '';
    const levelStr = level ? ` ${level.toUpperCase()}:` : '';
    console.log(`${timestamp}${levelStr}${rid} ${msg}`);
  }

  // Emit event for real-time monitoring
  eventEmitter.emit('log', {
    timestamp,
    level,
    message: String(msg),
    requestId: context.requestId
  });
}

function getLogContext(requestId, level = 'info') {
  return { requestId, level };
}

module.exports = {
  metrics,
  log,
  getLogContext,
  eventEmitter,
};
