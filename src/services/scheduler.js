'use strict';

const { 
  SCHEDULER_ENABLE, SCHEDULER_TIMEZONE, SCHEDULER_MAX_RETRIES, 
  SCHEDULER_RETRY_BASE_SECONDS, SCHEDULER_MAX_ACTIVE_PER_USER, 
  SCHEDULER_MAX_ACTIVE_PER_CHANNEL, SCHEDULER_CLAIM_LIMIT, 
  SCHEDULER_RETENTION_DAYS, INCOMING_URL, 
  allowedUsersSet, allowedChannelsSet, adminUsersSet
} = require('../config');
const { log, metrics } = require('../logger');
const { schedulerStore } = require('../stores');
const { 
  parseAtDateTime, parseCronExpression, nextCronRunIso, truncateReply 
} = require('../utils');
const { postToIncomingWebhook } = require('./webhook');
const { runPromptWithMemory } = require('./chat');
const { enqueueTask } = require('../queue');

function scheduleHelpText() {
  return [
    '排程指令：',
    '1. schedule at YYYY-MM-DD HH:MM <任務>',
    '2. schedule cron <m h dom mon dow> <任務>',
    '3. schedule list',
    '4. schedule pause <job_id>',
    '5. schedule resume <job_id>',
    '6. schedule cancel <job_id>',
    `時區預設：${SCHEDULER_TIMEZONE}`,
  ].join('\n');
}

function getActor(data) {
  const username = String(data.username || data.user_name || data.user || '').trim();
  const channel = String(data.channel_id || data.channel_name || '').trim();
  const userId = String(data.user_id || '').trim();

  return {
    username,
    usernameKey: username.toLowerCase(),
    channel: (channel && channel !== 'unknown') ? channel : 'unknown',
    channelKey: (channel && channel !== 'unknown') ? channel.toLowerCase() : 'unknown',
    userId,
  };
}

function isAdminUser(usernameKey) {
  return usernameKey && adminUsersSet.has(usernameKey);
}

function canUseScheduler(actor) {
  if (allowedUsersSet.size > 0 && !allowedUsersSet.has(actor.usernameKey)) {
    return { ok: false, reason: `使用者 ${actor.username || '(unknown)'} 不在排程白名單` };
  }
  if (allowedChannelsSet.size > 0 && !allowedChannelsSet.has(actor.channelKey)) {
    return { ok: false, reason: `頻道 ${actor.channel || '(unknown)'} 不在排程白名單` };
  }
  return { ok: true };
}

async function canManageJob(actor, jobId) {
  const job = await schedulerStore.getJobById(jobId);
  if (!job) return { ok: false, reason: '找不到排程' };
  if (isAdminUser(actor.usernameKey)) return { ok: true, job };
  const ownerKey = String(job.username || '').toLowerCase();
  if (ownerKey && ownerKey === actor.usernameKey) return { ok: true, job };
  return { ok: false, reason: `排程 #${jobId} 不是你的工作` };
}

async function checkCreateQuota(actor) {
  const userCount = await schedulerStore.countActiveByUser(actor.username);
  if (userCount >= SCHEDULER_MAX_ACTIVE_PER_USER) {
    return { ok: false, reason: `你的排程數已達上限 ${SCHEDULER_MAX_ACTIVE_PER_USER}` };
  }
  const chCount = await schedulerStore.countActiveByChannel(actor.channel);
  if (chCount >= SCHEDULER_MAX_ACTIVE_PER_CHANNEL) {
    return { ok: false, reason: `此頻道排程數已達上限 ${SCHEDULER_MAX_ACTIVE_PER_CHANNEL}` };
  }
  return { ok: true };
}

async function handleScheduleCommand(cmd, data) {
  metrics.schedule_commands_total += 1;

  if (String(SCHEDULER_ENABLE) !== 'true') {
    return '排程功能未啟用。請設定 SCHEDULER_ENABLE=true。';
  }

  const actor = getActor(data);
  const allowed = canUseScheduler(actor);
  if (!allowed.ok) {
    metrics.schedule_commands_denied_total += 1;
    return `無權限使用排程：${allowed.reason}`;
  }

  if (cmd.action === 'help') {
    return scheduleHelpText();
  }

  if (cmd.action === 'list') {
    const rows = isAdminUser(actor.usernameKey)
      ? await schedulerStore.listJobs(20)
      : await schedulerStore.listJobsByUser(actor.username, 20);
    if (rows.length === 0) return '目前沒有進行中的排程。';
    const lines = ['目前排程：'];
    for (const row of rows) {
      const typePart = row.type === 'cron' ? `cron:${row.cron_expr || '-'}` : 'one_time';
      const retryPart = `retry ${Number(row.retry_count || 0)}/${Number(row.max_retries || 0)}`;
      lines.push(`#${row.id} [${row.status}] ${typePart} @ ${row.run_at} (${retryPart}) :: ${String(row.prompt || '').slice(0, 80)}`);
    }
    return lines.join('\n');
  }

  if (cmd.action === 'cancel') {
    const manage = await canManageJob(actor, cmd.id);
    if (!manage.ok) {
      metrics.schedule_commands_denied_total += 1;
      return `無法取消：${manage.reason}`;
    }
    const ok = await schedulerStore.cancelJob(cmd.id);
    return ok ? `已取消排程 #${cmd.id}` : `找不到可取消的排程 #${cmd.id}`;
  }

  if (cmd.action === 'pause') {
    const manage = await canManageJob(actor, cmd.id);
    if (!manage.ok) {
      metrics.schedule_commands_denied_total += 1;
      return `無法暫停：${manage.reason}`;
    }
    const ok = await schedulerStore.pauseJob(cmd.id);
    return ok ? `已暫停排程 #${cmd.id}` : `找不到可暫停的排程 #${cmd.id}`;
  }

  if (cmd.action === 'resume') {
    const manage = await canManageJob(actor, cmd.id);
    if (!manage.ok) {
      metrics.schedule_commands_denied_total += 1;
      return `無法恢復：${manage.reason}`;
    }
    const ok = await schedulerStore.resumeJob(cmd.id);
    return ok ? `已恢復排程 #${cmd.id}` : `找不到可恢復的排程 #${cmd.id}`;
  }

  if (cmd.action === 'create_at') {
    const quota = await checkCreateQuota(actor);
    if (!quota.ok) {
      metrics.schedule_commands_denied_total += 1;
      return `建立失敗：${quota.reason}`;
    }
    const runAtIso = parseAtDateTime(cmd.runAtInput);
    if (!runAtIso) {
      return `時間格式錯誤，請使用 YYYY-MM-DD HH:MM（${SCHEDULER_TIMEZONE}）。`;
    }
    if (new Date(runAtIso).getTime() <= Date.now()) {
      return '排程時間需晚於現在。';
    }
    if (!cmd.prompt) {
      return '排程內容不可空白。';
    }
    const targetChannel = (actor.channel && actor.channel !== 'unknown') ? actor.channel : actor.userId;
    const jobId = await schedulerStore.createOneTime({
      prompt: cmd.prompt,
      runAtIso,
      channel: targetChannel,
      username: actor.username,
      timezone: SCHEDULER_TIMEZONE,
      maxRetries: SCHEDULER_MAX_RETRIES,
      retryBaseSeconds: SCHEDULER_RETRY_BASE_SECONDS,
    });
    return `已建立排程 #${jobId}\n執行時間: ${runAtIso}\n任務: ${cmd.prompt}\n對象: ${targetChannel || 'unknown'}`;
  }

  if (cmd.action === 'create_cron') {
    const quota = await checkCreateQuota(actor);
    if (!quota.ok) {
      metrics.schedule_commands_denied_total += 1;
      return `建立失敗：${quota.reason}`;
    }
    const parsed = parseCronExpression(cmd.cronExpr);
    if (!parsed) {
      return 'Cron 格式錯誤，請使用 5 欄位：m h dom mon dow（例如：0 9 * * 1-5）';
    }
    if (!cmd.prompt) {
      return '排程內容不可空白。';
    }
    const runAtIso = nextCronRunIso(parsed, new Date());
    if (!runAtIso) {
      return '無法計算下一次執行時間，請檢查 cron 表達式。';
    }
    const targetChannel = (actor.channel && actor.channel !== 'unknown') ? actor.channel : actor.userId;
    const jobId = await schedulerStore.createCron({
      prompt: cmd.prompt,
      runAtIso,
      cronExpr: parsed.expr,
      channel: targetChannel,
      username: actor.username,
      timezone: SCHEDULER_TIMEZONE,
      maxRetries: SCHEDULER_MAX_RETRIES,
      retryBaseSeconds: SCHEDULER_RETRY_BASE_SECONDS,
    });
    return `已建立 cron 排程 #${jobId}\nCron: ${parsed.expr}\n下次執行: ${runAtIso}\n任務: ${cmd.prompt}\n對象: ${targetChannel || 'unknown'}`;
  }

  return scheduleHelpText();
}

async function runSchedulerTick() {
  if (String(SCHEDULER_ENABLE) !== 'true') return;
  metrics.scheduler_ticks_total += 1;

  let dueJobs = [];
  try {
    dueJobs = await schedulerStore.claimDueJobs(SCHEDULER_CLAIM_LIMIT);
    metrics.scheduler_jobs_claimed_total += dueJobs.length;
  } catch (err) {
    log('scheduler claim failed:', err.message);
    return;
  }

  for (const job of dueJobs) {
    const enqueued = enqueueTask(async () => {
      const jobId = Number(job.id);
      const user = String(job.username || 'scheduler');
      const channelStr = String(job.channel || '');
      const promptText = String(job.prompt || '').trim();
      
      if (!promptText) {
        await schedulerStore.markRetryOrFailed(
          jobId,
          'empty_prompt',
          Number(job.retry_count || 0),
          Number(job.max_retries || 0),
          Number(job.retry_base_seconds || SCHEDULER_RETRY_BASE_SECONDS),
        );
        return;
      }

      const isNumeric = /^\d+$/.test(channelStr) && channelStr !== '0';
      const fakeData = {
        username: user,
        user_name: user,
        channel_name: isNumeric ? 'ID_' + channelStr : (channelStr || 'unknown'),
        channel_id: isNumeric ? channelStr : undefined,
        user_id: isNumeric ? channelStr : undefined 
      };

      try {
        log(`running scheduled job #${jobId} for target=${channelStr}`);
        const schedulePrompt = [
          `[系統通知：排程執行時間已到]`,
          `任務編號：${jobId}`,
          `任務內容：${promptText}`,
          '',
          `請注意：你現在是代表系統發出預定的提醒。`,
          `請直接針對「任務內容」進行回覆或執行動作。`,
          `**絕對不要** 提及排程管理、不要查詢列表、不要問使用者是否要刪除排程。`,
          `請以親切、簡短的方式直接傳達提醒資訊即可。`,
          '',
          `任務內容如下：`,
          promptText,
        ].join('\n');

        const output = await runPromptWithMemory(promptText, fakeData, 'scheduler', {
          promptOverride: schedulePrompt,
          scope: 'long',
          onProgress: (elapsedMs) => {
            const seconds = Math.floor(elapsedMs / 1000);
            postToIncomingWebhook(`[排程 #${jobId}] Codex 正在執行中... (已耗時 ${seconds} 秒)`, fakeData).catch((e) => {
              log('scheduler heartbeat failed:', e.message);
            });
          },
          tags: [
            'scheduler',
            `job:${jobId}`,
            `type:${String(job.type || 'one_time')}`,
            String(job.cron_expr || '') ? 'cron' : 'one_time',
          ],
          metadata: {
            job_id: jobId,
            job_type: String(job.type || 'one_time'),
            cron_expr: String(job.cron_expr || ''),
            run_at: String(job.run_at || ''),
          },
        });
        if (String(job.type || 'one_time') === 'cron') {
          const parsed = parseCronExpression(String(job.cron_expr || ''));
          if (!parsed) {
            throw new Error('invalid_cron_expression');
          }
          const nextRunIso = nextCronRunIso(parsed, new Date());
          if (!nextRunIso) {
            throw new Error('next_cron_run_not_found');
          }
          await schedulerStore.completeCron(jobId, truncateReply(output), nextRunIso);
        } else {
          await schedulerStore.completeOneTime(jobId, truncateReply(output));
        }
        metrics.scheduler_jobs_success_total += 1;

        if (INCOMING_URL) {
          const msg = [
            `排程 #${jobId} 已完成`,
            `時間: ${new Date().toISOString()}`,
            `任務: ${promptText}`,
            '',
            truncateReply(output),
          ].join('\n');
          await postToIncomingWebhook(msg, fakeData);
        }
      } catch (err) {
        const errMsg = `job #${jobId} failed: ${err.message || 'unknown_error'}`;
        log(errMsg);
        const retryResult = await schedulerStore.markRetryOrFailed(
          jobId,
          truncateReply(errMsg),
          Number(job.retry_count || 0),
          Number(job.max_retries || 0),
          Number(job.retry_base_seconds || SCHEDULER_RETRY_BASE_SECONDS),
        );
        if (retryResult.status === 'retry') {
          metrics.scheduler_jobs_retry_total += 1;
        } else if (retryResult.status === 'failed') {
          metrics.scheduler_jobs_failed_total += 1;
        }
        if (INCOMING_URL) {
          try {
            if (retryResult.status === 'retry') {
              await postToIncomingWebhook(
                `排程 #${jobId} 執行失敗，將重試\n任務: ${promptText}\n錯誤: ${truncateReply(err.message || 'unknown_error')}\n重試次數: ${retryResult.retryCount}/${Number(job.max_retries || 0)}\n下次重試: ${retryResult.runAt}`,
                fakeData
              );
            } else {
              await postToIncomingWebhook(`排程 #${jobId} 執行失敗\n任務: ${promptText}\n錯誤: ${truncateReply(err.message || 'unknown_error')}`, fakeData);
            }
          } catch (postErr) {
            log('failed to send scheduled error:', postErr.message);
          }
        }
      }
    }, `scheduler_job_${job.id}`);
    if (!enqueued.ok) {
      const errMsg = `queue_backpressure_${enqueued.reason || 'unknown'}`;
      await schedulerStore.markRetryOrFailed(
        Number(job.id),
        errMsg,
        Number(job.retry_count || 0),
        Number(job.max_retries || 0),
        Number(job.retry_base_seconds || SCHEDULER_RETRY_BASE_SECONDS),
      );
      log(`scheduler job ${job.id} requeued due to ${errMsg}`);
    }
  }
}

async function runSchedulerCleanup() {
  if (String(SCHEDULER_ENABLE) !== 'true') return;
  try {
    const deleted = await schedulerStore.cleanupOldJobs(SCHEDULER_RETENTION_DAYS);
    metrics.scheduler_cleanup_runs_total += 1;
    metrics.scheduler_cleanup_deleted_total += deleted;
    if (deleted > 0) {
      log(`scheduler cleanup deleted ${deleted} old jobs`);
    }
  } catch (err) {
    log('scheduler cleanup failed:', err.message);
  }
}

module.exports = {
  handleScheduleCommand,
  runSchedulerTick,
  runSchedulerCleanup,
};
