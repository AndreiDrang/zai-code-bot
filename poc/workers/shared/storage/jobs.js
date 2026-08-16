import { batch, changedRows, first, prepare, run } from './database.js';
import { getJob } from './deliveries.js';
import { STORAGE_SCHEMA_VERSION } from './keys.js';

export const MAX_JOB_ATTEMPTS = 3;
export const JOB_LEASE_SECONDS = 10 * 60;

function addSeconds(now, seconds) {
  return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
}

export async function claimJob(
  db,
  jobId,
  now = new Date().toISOString(),
  maxAttempts = MAX_JOB_ATTEMPTS,
  leaseSeconds = JOB_LEASE_SECONDS,
) {
  const leaseExpiresAt = addSeconds(now, leaseSeconds);
  const result = await run(
    prepare(
      db,
      `UPDATE jobs
       SET status = 'running', claimed_at = ?, lease_expires_at = ?,
           attempt_count = attempt_count + 1, updated_at = ?
       WHERE job_id = ?
         AND attempt_count < ?
         AND (
           (status IN ('queued', 'retryable') AND available_at <= ?)
           OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
         )`,
      now,
      leaseExpiresAt,
      now,
      jobId,
      maxAttempts,
      now,
      now,
    ),
  );
  if (!changedRows(result)) return null;
  return getJob(db, jobId);
}

export async function startAnalysisRun(db, jobId, attempt, now = new Date().toISOString()) {
  const runId = crypto.randomUUID();
  await run(
    prepare(
      db,
      `INSERT INTO analysis_runs
       (run_id, job_id, attempt, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      runId,
      jobId,
      attempt,
      now,
      now,
      now,
    ),
  );
  return runId;
}

export async function linkRunResultArtifact(db, runId, artifactId, now = new Date().toISOString()) {
  await run(
    prepare(
      db,
      `UPDATE analysis_runs SET result_artifact_id = ?, updated_at = ? WHERE run_id = ?`,
      artifactId,
      now,
      runId,
    ),
  );
}

export async function markJobSucceeded(db, jobId, runId, now = new Date().toISOString()) {
  const statements = [
    prepare(
      db,
      `UPDATE jobs
       SET status = 'succeeded', completed_at = ?, lease_expires_at = NULL,
           updated_at = ?, last_error_code = NULL
       WHERE job_id = ?`,
      now,
      now,
      jobId,
    ),
  ];
  if (runId) {
    statements.push(
      prepare(
        db,
        `UPDATE analysis_runs SET status = 'succeeded', completed_at = ?, updated_at = ? WHERE run_id = ?`,
        now,
        now,
        runId,
      ),
    );
  }
  await batch(db, statements);
}

export async function markJobRetryable(
  db,
  jobId,
  runId,
  errorCode,
  delaySeconds,
  now = new Date(),
) {
  const availableAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  const timestamp = now.toISOString();
  const statements = [
    prepare(
      db,
      `UPDATE jobs
       SET status = 'retryable', available_at = ?, last_error_code = ?,
           last_failure_at = ?, lease_expires_at = NULL, updated_at = ?
       WHERE job_id = ?`,
      availableAt,
      errorCode,
      timestamp,
      timestamp,
      jobId,
    ),
  ];
  if (runId) {
    statements.push(
      prepare(
        db,
        `UPDATE analysis_runs
         SET status = 'retryable', error_code = ?, completed_at = ?, updated_at = ?
         WHERE run_id = ?`,
        errorCode,
        timestamp,
        timestamp,
        runId,
      ),
    );
  }
  await batch(db, statements);
}

export async function markJobFailed(db, jobId, runId, errorCode, now = new Date().toISOString()) {
  const statements = [
    prepare(
      db,
      `UPDATE jobs
       SET status = 'failed', completed_at = ?, last_error_code = ?,
           last_failure_at = ?, lease_expires_at = NULL, updated_at = ?
       WHERE job_id = ?`,
      now,
      errorCode,
      now,
      now,
      jobId,
    ),
  ];
  if (runId) {
    statements.push(
      prepare(
        db,
        `UPDATE analysis_runs
         SET status = 'failed', error_code = ?, completed_at = ?, updated_at = ?
         WHERE run_id = ?`,
        errorCode,
        now,
        now,
        runId,
      ),
    );
  }
  await batch(db, statements);
}

export async function listExpiredRunningJobs(db, limit = 100, now = new Date().toISOString()) {
  const result = await prepare(
    db,
    `SELECT job_id, attempt_count, kind FROM jobs
     WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
     ORDER BY lease_expires_at LIMIT ?`,
    now,
    Math.min(Math.max(Number(limit) || 1, 1), 500),
  ).all();
  return result?.results || [];
}

/** Requeues an expired lease or permanently fails it after the attempt budget. */
export async function recoverExpiredJob(
  db,
  jobId,
  now = new Date().toISOString(),
  maxAttempts = MAX_JOB_ATTEMPTS,
) {
  const job = await first(
    prepare(
      db,
      `SELECT attempt_count FROM jobs
       WHERE job_id = ? AND status = 'running'
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      jobId,
      now,
    ),
  );
  if (!job) return null;

  if (Number(job.attempt_count) < maxAttempts) {
    const results = await batch(db, [
      prepare(
        db,
        `UPDATE jobs
         SET status = 'retryable', available_at = ?, last_error_code = 'worker_lease_expired',
             last_failure_at = ?, lease_expires_at = NULL, updated_at = ?
         WHERE job_id = ? AND status = 'running'
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        now,
        now,
        now,
        jobId,
        now,
      ),
      prepare(
        db,
        `UPDATE analysis_runs SET status = 'retryable', error_code = 'worker_lease_expired',
         completed_at = ?, updated_at = ? WHERE job_id = ? AND status = 'running'`,
        now,
        now,
        jobId,
      ),
      prepare(
        db,
        `UPDATE job_outbox SET published_at = NULL, next_attempt_at = ?, updated_at = ? WHERE job_id = ?`,
        now,
        now,
        jobId,
      ),
    ]);
    return changedRows(results?.[0]) ? 'requeued' : null;
  }

  const results = await batch(db, [
    prepare(
      db,
      `UPDATE jobs
       SET status = 'failed', completed_at = ?, last_error_code = 'operation_failed',
           last_failure_at = ?, lease_expires_at = NULL, updated_at = ?
       WHERE job_id = ? AND status = 'running'
         AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      now,
      now,
      now,
      jobId,
      now,
    ),
    prepare(
      db,
      `UPDATE analysis_runs SET status = 'failed', error_code = 'operation_failed',
       completed_at = ?, updated_at = ? WHERE job_id = ? AND status = 'running'`,
      now,
      now,
      jobId,
    ),
  ]);
  return changedRows(results?.[0]) ? 'failed' : null;
}

export async function markOutboxPublished(db, jobId, now = new Date().toISOString()) {
  await run(
    prepare(
      db,
      `UPDATE job_outbox SET published_at = ?, publish_attempts = publish_attempts + 1, updated_at = ? WHERE job_id = ?`,
      now,
      now,
      jobId,
    ),
  );
}

/**
 * Publishes a job directly when a worker has a producer binding. The D1 outbox
 * remains the recovery path for crashes or queue errors.
 */
export async function publishOutboxJob(env, db, jobId, now = new Date().toISOString()) {
  if (!env?.BOT_JOBS?.send) return false;
  await env.BOT_JOBS.send(queueMessage(jobId));
  await markOutboxPublished(db, jobId, now);
  return true;
}

export async function recordOutboxFailure(db, jobId, errorCode, delaySeconds, now = new Date()) {
  const timestamp = now.toISOString();
  const nextAttemptAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  await run(
    prepare(
      db,
      `UPDATE job_outbox
       SET publish_attempts = publish_attempts + 1, last_publish_error = ?, next_attempt_at = ?, updated_at = ?
       WHERE job_id = ? AND published_at IS NULL`,
      errorCode,
      nextAttemptAt,
      timestamp,
      jobId,
    ),
  );
}

export async function listDueOutbox(db, limit = 25, now = new Date().toISOString()) {
  const result = await prepare(
    db,
    `SELECT job_id FROM job_outbox WHERE published_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`,
    now,
    Math.min(Math.max(Number(limit) || 1, 1), 100),
  ).all();
  return result?.results || [];
}

export function queueMessage(jobId) {
  return { schemaVersion: STORAGE_SCHEMA_VERSION, jobId };
}
