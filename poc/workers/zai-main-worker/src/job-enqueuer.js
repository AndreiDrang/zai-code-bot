import {
  recordOutboxFailure,
  markOutboxPublished,
  queueMessage,
  listDueOutbox,
  listExpiredRunningJobs,
  recoverExpiredJob,
} from '../../shared/storage/jobs.js';
import { safeErrorCode } from '../../shared/storage/database.js';
import { deleteExpiredArtifacts } from '../../shared/storage/artifacts.js';
import { createLogger } from '../../shared/logging.js';

const OUTBOX_RETRY_SECONDS = 30;

export async function enqueueJob(env, jobId) {
  if (!env.BOT_JOBS?.send) throw new Error('BOT_JOBS queue binding is not configured');
  try {
    await env.BOT_JOBS.send(queueMessage(jobId));
    await markOutboxPublished(env.BOT_DB, jobId);
    return true;
  } catch (error) {
    await recordOutboxFailure(
      env.BOT_DB,
      jobId,
      safeErrorCode(error, 'queue_publish_failed'),
      OUTBOX_RETRY_SECONDS,
    );
    throw error;
  }
}

export async function sweepExpiredStorage(env, limit = 100) {
  if (!env.BOT_ARTIFACTS?.delete) return { found: 0, deleted: 0, skipped: true };
  return deleteExpiredArtifacts({ db: env.BOT_DB, bucket: env.BOT_ARTIFACTS, limit });
}

export async function recoverExpiredJobs(env, limit = 100) {
  const logger = createLogger(env, 'zai-main-worker:job-recovery');
  const rows = await listExpiredRunningJobs(env.BOT_DB, limit);
  let requeued = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await recoverExpiredJob(env.BOT_DB, row.job_id);
    if (result === 'requeued') {
      requeued += 1;
      logger.warn('Expired job lease requeued', {
        jobId: row.job_id,
        kind: row.kind,
        attempt: row.attempt_count,
        errorCode: 'worker_lease_expired',
      });
    }
    if (result === 'failed') {
      failed += 1;
      logger.error('Expired job operation_failed', {
        jobId: row.job_id,
        kind: row.kind,
        attempt: row.attempt_count,
        errorCode: 'operation_failed',
      });
    }
  }
  return { found: rows.length, requeued, failed };
}

export async function replayDueOutbox(env, limit = 25) {
  const rows = await listDueOutbox(env.BOT_DB, limit);
  let published = 0;
  for (const row of rows) {
    try {
      await enqueueJob(env, row.job_id);
      published += 1;
    } catch {
      // Keep processing the bounded batch; the next cron invocation retries it.
    }
  }
  return { found: rows.length, published };
}
