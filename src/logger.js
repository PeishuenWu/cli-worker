'use strict';

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

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

module.exports = {
  metrics,
  log,
};
