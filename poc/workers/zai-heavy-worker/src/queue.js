import { GitHubClient } from '../../shared/github.js';
import { createLogger, generateCorrelationId } from '../../shared/logging.js';
import { resolveSecretValue } from '../../shared/secrets.js';
import { getJob } from '../../shared/storage/deliveries.js';
import { safeErrorCode } from '../../shared/storage/database.js';
import {
  claimJob,
  markJobFailed,
  markJobRetryable,
  markJobSucceeded,
  MAX_JOB_ATTEMPTS,
  startAnalysisRun,
} from '../../shared/storage/jobs.js';
import { getHeavyHandler } from './handlers/index.js';

export const MAX_ATTEMPTS = MAX_JOB_ATTEMPTS;

export async function processQueueBatch(batch, env) {
  const logger = createLogger(env, 'zai-heavy-worker:queue');
  for (const message of batch.messages || []) {
    await processQueueMessage(message, env, logger);
  }
}

export async function processQueueMessage(
  message,
  env,
  logger = createLogger(env, 'zai-heavy-worker:queue'),
) {
  const body = message?.body;
  const jobId = body?.jobId;
  if (!jobId || Number(body?.schemaVersion) !== 1) {
    message.ack();
    logger.warn('Acked invalid queue message', { correlationId: generateCorrelationId() });
    return;
  }

  const job = await getJob(env.BOT_DB, jobId);
  if (!job) {
    message.ack();
    logger.warn('Acked queue message for missing job', { jobId });
    return;
  }

  const claimed = await claimJob(env.BOT_DB, jobId);
  if (!claimed) {
    // Another delivery is already running, the lease has not expired, or the
    // job is complete. The owner of the active lease will finish it.
    message.ack();
    return;
  }

  let runId = null;
  try {
    const handler = getHeavyHandler(claimed.kind);
    if (!handler) {
      const unsupported = new Error('Unsupported durable job kind');
      unsupported.retryable = false;
      unsupported.code = 'unsupported_job_kind';
      throw unsupported;
    }
    runId = await startAnalysisRun(env.BOT_DB, jobId, claimed.attempt_count);
    const github = new GitHubClient(await resolveSecretValue(env.GITHUB_TOKEN));
    await handler({ github, env, db: env.BOT_DB, job: claimed, runId });
    await markJobSucceeded(env.BOT_DB, jobId, runId);
    message.ack();
    logger.info('Queue job completed', { jobId, kind: claimed.kind, runId });
  } catch (error) {
    const errorCode = safeErrorCode(error, 'job_failed');
    const retryable = error?.retryable !== false && claimed.attempt_count < MAX_ATTEMPTS;
    const delaySeconds = retryable ? Math.min(300, 2 ** claimed.attempt_count * 10) : 0;

    try {
      if (retryable) {
        await markJobRetryable(env.BOT_DB, jobId, runId, errorCode, delaySeconds);
      } else {
        await markJobFailed(env.BOT_DB, jobId, runId, 'operation_failed');
      }
    } catch (transitionError) {
      // Do not ack when D1 could not record the transition. Queue delivery can
      // retry, and the lease recovery cron handles a worker crash after claim.
      message.retry({ delaySeconds: 30 });
      logger.error('Queue job state transition failed', {
        jobId,
        runId,
        attempt: claimed.attempt_count,
        errorCode: safeErrorCode(transitionError, 'storage_error'),
      });
      return;
    }

    if (retryable) {
      message.retry({ delaySeconds });
      logger.warn('Queue job scheduled for retry', {
        jobId,
        kind: claimed.kind,
        runId,
        errorCode,
        attempt: claimed.attempt_count,
      });
    } else {
      message.ack();
      logger.error('Queue job operation_failed', {
        jobId,
        kind: claimed.kind,
        runId,
        errorCode: 'operation_failed',
        causeCode: errorCode,
        attempt: claimed.attempt_count,
      });
    }
  }
}
