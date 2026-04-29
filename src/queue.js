'use strict';

const { TASK_CONCURRENCY, TASK_QUEUE_MAX } = require('./config');
const { metrics, log } = require('./logger');

const taskQueue = [];
let taskRunning = 0;

function getQueueState() {
  return {
    length: taskQueue.length,
    running: taskRunning,
    concurrency: TASK_CONCURRENCY,
    max: TASK_QUEUE_MAX,
  };
}

function pumpTaskQueue() {
  while (taskRunning < TASK_CONCURRENCY && taskQueue.length > 0) {
    const task = taskQueue.shift();
    taskRunning += 1;
    Promise.resolve()
      .then(task.fn)
      .then(() => {
        metrics.task_queue_completed_total += 1;
      })
      .catch((err) => {
        metrics.task_queue_failed_total += 1;
        log(`queue task failed (${task.name}):`, err.message);
      })
      .finally(() => {
        taskRunning -= 1;
        pumpTaskQueue();
      });
  }
}

function enqueueTask(fn, name = 'task') {
  if (typeof fn !== 'function') {
    return { ok: false, reason: 'invalid_task' };
  }
  if (taskQueue.length >= TASK_QUEUE_MAX) {
    metrics.task_queue_rejected_total += 1;
    return { ok: false, reason: 'queue_full' };
  }
  taskQueue.push({ fn, name });
  metrics.task_queue_enqueued_total += 1;
  pumpTaskQueue();
  return { ok: true };
}

module.exports = {
  taskQueue,
  taskRunning,
  getQueueState,
  pumpTaskQueue,
  enqueueTask,
};
