import { GitHubClient } from '../../shared/github.js';
import { createLogger, generateCorrelationId } from '../../shared/logging.js';
import { createTokenProvider } from '../../shared/github-app-auth.js';
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

/**
 * Creates a GitHub client for queue processing. GitHub App auth is the ONLY
 * path (PAT support removed). Config/permanent failures throw with
 * `retryable: false` so the queue fails the job instead of burning attempts;
 * transient mint failures (network, 5xx) retry with backoff via the
 * provider's classified appAuthError.
 * @param {Object} env - Environment bindings
 * @param {Object} job - Claimed job row (carries installation_id)
 * @param {Object} logger - Logger instance
 * @returns {Promise<GitHubClient>}
 */
async function createQueueGitHubClient(env, job, logger) {
  if (!job.installation_id) {
    // Pre-migration job (created before installation_id was recorded): it
    // can never authenticate post-PAT-removal — fail fast, do not retry.
    const legacy = new Error('missing_installation_id');
    legacy.code = 'missing_installation_id';
    legacy.retryable = false;
    throw legacy;
  }

  const provider = await createTokenProvider(env);
  if (!provider.available) {
    const unconfigured = new Error('app_auth_unconfigured');
    unconfigured.code = 'app_auth_unconfigured';
    unconfigured.retryable = false;
    throw unconfigured;
  }

  // Throws a classified appAuthError on failure (code + retryable).
  const token = await provider.getInstallationToken(job.installation_id);
  logger.info('Using GitHub App authentication for queue job', {
    installationId: job.installation_id,
    jobId: job.job_id,
  });
  return new GitHubClient(token);
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
    // claimJob also rejects a redelivery that arrives BEFORE the D1 row is
    // due (clock/scheduling skew between the queue and the worker, or a crash
    // between markJobRetryable and message.retry). Acking here would strand
    // the job forever — re-delay it so the queue redelivers once it is due.
    const availableAtMs = job.available_at ? Date.parse(job.available_at) : null;
    if (
      (job.status === 'retryable' || job.status === 'queued') &&
      availableAtMs !== null &&
      availableAtMs > Date.now()
    ) {
      const delaySeconds = Math.min(
        300,
        Math.max(1, Math.ceil((availableAtMs - Date.now()) / 1000)),
      );
      message.retry({ delaySeconds });
      logger.warn('Redelivery preceded available_at; re-delayed', {
        jobId,
        status: job.status,
        available_at: job.available_at,
        delaySeconds,
      });
      return;
    }
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

    // Create GitHub client with App auth if installation_id is available
    const github = await createQueueGitHubClient(env, claimed, logger);

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
