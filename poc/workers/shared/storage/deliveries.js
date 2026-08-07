import { PR_PREVIEW_JOB_KIND, STORAGE_SCHEMA_VERSION } from './keys.js';
import { batch, first, prepare } from './database.js';

const JOB_SELECT = `
  SELECT j.job_id, j.delivery_id, j.kind, j.repository_id, j.pr_number, j.head_sha,
         j.status, j.attempt_count, j.available_at, j.claimed_at, j.lease_expires_at,
         j.completed_at, j.last_error_code, j.last_failure_at, j.config_version,
         r.owner AS repository_owner, r.name AS repository_name, r.full_name AS repository_full_name,
         p.title, p.author_login, p.state, p.closed_by
  FROM jobs j
  JOIN repositories r ON r.repository_id = j.repository_id
  JOIN pull_requests p ON p.repository_id = j.repository_id AND p.pr_number = j.pr_number
  WHERE j.delivery_id = ?
`;

function validateEvent(event) {
  const required = ['deliveryId', 'repositoryId', 'repository', 'prNumber', 'headSha'];
  for (const field of required) {
    if (event?.[field] === undefined || event?.[field] === null || event?.[field] === '') {
      throw new TypeError(`Missing PR event field: ${field}`);
    }
  }
  if (!Number.isInteger(Number(event.repositoryId)) || Number(event.repositoryId) <= 0) {
    throw new TypeError('repositoryId must be a positive integer');
  }
  if (!Number.isInteger(Number(event.prNumber)) || Number(event.prNumber) <= 0) {
    throw new TypeError('prNumber must be a positive integer');
  }
}

/**
 * Atomically records a pull_request delivery and creates its preview job.
 * Duplicate GitHub deliveries return the existing job without creating state.
 */
export async function createPrPreviewJob(db, event, now = new Date().toISOString()) {
  validateEvent(event);
  const existing = await first(prepare(db, JOB_SELECT, event.deliveryId));
  if (existing) return { job: existing, created: false };

  const jobId = crypto.randomUUID();
  const repositoryId = Number(event.repositoryId);
  const prNumber = Number(event.prNumber);
  const statements = [
    prepare(
      db,
      `INSERT OR IGNORE INTO repositories
       (repository_id, full_name, owner, name, default_branch, config_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      repositoryId,
      event.repository.fullName,
      event.repository.owner,
      event.repository.name,
      event.repository.defaultBranch || null,
      now,
      now,
    ),
    prepare(
      db,
      `INSERT INTO pull_requests
       (repository_id, pr_number, head_sha, base_sha, title, author_login, state, closed_by, last_event_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repository_id, pr_number) DO UPDATE SET
         head_sha = excluded.head_sha, base_sha = excluded.base_sha,
         title = excluded.title, author_login = excluded.author_login,
         state = excluded.state,
         closed_by = COALESCE(excluded.closed_by, pull_requests.closed_by),
         last_event_at = excluded.last_event_at,
         updated_at = excluded.updated_at`,
      repositoryId,
      prNumber,
      event.headSha,
      event.baseSha || null,
      event.title || null,
      event.authorLogin || null,
      event.state || 'open',
      event.closedBy || null,
      now,
      now,
      now,
    ),
    prepare(
      db,
      `INSERT INTO webhook_deliveries
       (delivery_id, event_name, action, repository_id, pr_number, head_sha, received_at)
       VALUES (?, 'pull_request', ?, ?, ?, ?, ?)`,
      event.deliveryId,
      event.action,
      repositoryId,
      prNumber,
      event.headSha,
      now,
    ),
    prepare(
      db,
      `INSERT INTO jobs
       (job_id, delivery_id, kind, repository_id, pr_number, head_sha, status,
        attempt_count, available_at, config_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, 1, ?, ?)`,
      jobId,
      event.deliveryId,
      PR_PREVIEW_JOB_KIND,
      repositoryId,
      prNumber,
      event.headSha,
      now,
      now,
      now,
    ),
    prepare(
      db,
      `INSERT INTO job_outbox
       (job_id, published_at, publish_attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, NULL, 0, ?, ?, ?)`,
      jobId,
      now,
      now,
      now,
    ),
  ];

  try {
    await batch(db, statements);
  } catch (error) {
    // A concurrent duplicate can win the unique delivery constraint. Reading
    // the winner makes webhook retries safe without exposing SQL internals.
    const duplicate = await first(prepare(db, JOB_SELECT, event.deliveryId));
    if (duplicate) return { job: duplicate, created: false };
    throw error;
  }

  const job = await first(prepare(db, JOB_SELECT, event.deliveryId));
  if (!job) throw new Error(`Created PR job ${jobId} could not be loaded`);
  return { job, created: true, schemaVersion: STORAGE_SCHEMA_VERSION };
}

export async function getJob(db, jobId) {
  return first(
    prepare(db, JOB_SELECT.replace('WHERE j.delivery_id = ?', 'WHERE j.job_id = ?'), jobId),
  );
}

export async function getJobByDelivery(db, deliveryId) {
  return first(prepare(db, JOB_SELECT, deliveryId));
}
