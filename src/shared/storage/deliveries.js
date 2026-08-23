import { PR_CONTEXT_JOB_KIND, PR_SUMMARY_JOB_KIND, STORAGE_SCHEMA_VERSION } from './keys.js';
import { batch, first, prepare } from './database.js';

const JOB_BASE = `
  SELECT j.job_id, j.delivery_id, j.kind, j.repository_id, j.pr_number,
         j.head_sha, p.base_sha,
         j.status, j.attempt_count, j.available_at, j.claimed_at, j.lease_expires_at,
         j.completed_at, j.last_error_code, j.last_failure_at, j.config_version,
         r.owner AS repository_owner, r.name AS repository_name, r.full_name AS repository_full_name,
         p.title, p.author_login, p.state, p.closed_by
  FROM jobs j
  JOIN repositories r ON r.repository_id = j.repository_id
  JOIN pull_requests p ON p.repository_id = j.repository_id AND p.pr_number = j.pr_number
`;

/** Loads the job of a specific kind created for a delivery (per-kind idempotency). */
function jobByDeliveryKind(db, deliveryId, kind) {
  return first(prepare(db, `${JOB_BASE} WHERE j.delivery_id = ? AND j.kind = ?`, deliveryId, kind));
}

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
 * Shared create path for a pull_request delivery job of a given `kind`.
 * `ownsDelivery` controls the webhook_deliveries insert: the FIRST job created
 * for a delivery inserts the delivery row (plain INSERT, doubling as the PK
 * race guard); a second job kind for the same delivery reuses that row via
 * INSERT OR IGNORE. Per-kind uniqueness is enforced by UNIQUE(delivery_id, kind)
 * (migration 0004), so the catch path reconciles a concurrent winner.
 */
async function createPrJob(db, event, kind, { ownsDelivery }, now = new Date().toISOString()) {
  validateEvent(event);
  const existing = await jobByDeliveryKind(db, event.deliveryId, kind);
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
      ownsDelivery
        ? `INSERT INTO webhook_deliveries
           (delivery_id, event_name, action, repository_id, pr_number, head_sha, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        : `INSERT OR IGNORE INTO webhook_deliveries
           (delivery_id, event_name, action, repository_id, pr_number, head_sha, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.deliveryId,
      event.eventName || 'pull_request',
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
      kind,
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
    // A concurrent duplicate can win the UNIQUE(delivery_id, kind) constraint.
    // Reading the winner makes webhook retries safe without exposing SQL internals.
    const duplicate = await jobByDeliveryKind(db, event.deliveryId, kind);
    if (duplicate) return { job: duplicate, created: false };
    throw error;
  }

  const job = await jobByDeliveryKind(db, event.deliveryId, kind);
  if (!job) throw new Error(`Created ${kind} job ${jobId} could not be loaded`);
  return { job, created: true, schemaVersion: STORAGE_SCHEMA_VERSION };
}

/**
 * Records (or returns the existing) eager PR-context gather job for a delivery.
 * Owns the delivery row and is idempotent on (delivery_id, 'pr_context').
 * Only created for headSha-producing actions.
 */
export function createPrContextJob(db, event, now) {
  return createPrJob(db, event, PR_CONTEXT_JOB_KIND, { ownsDelivery: true }, now);
}

/**
 * Records the structured PR-summary job produced by a successful context
 * gather. It shares the originating webhook delivery, but has its own kind and
 * outbox row, so the existing main-worker outbox replay publishes it to the
 * heavy worker without placing data in the queue message.
 */
export function createPrSummaryJob(db, contextJob, now) {
  return createPrJob(
    db,
    {
      deliveryId: contextJob.delivery_id,
      eventName: 'pull_request',
      action: 'context_ready',
      repositoryId: contextJob.repository_id,
      repository: {
        fullName: contextJob.repository_full_name,
        owner: contextJob.repository_owner,
        name: contextJob.repository_name,
        defaultBranch: null,
      },
      prNumber: contextJob.pr_number,
      headSha: contextJob.head_sha,
      baseSha: contextJob.base_sha,
      title: contextJob.title,
      authorLogin: contextJob.author_login,
      state: contextJob.state,
    },
    PR_SUMMARY_JOB_KIND,
    { ownsDelivery: false },
    now,
  );
}

/**
 * Records a durable job triggered by a /zai COMMAND (issue_comment), not a
 * pull_request webhook. The caller resolves the PR's head via getPullRequest so
 * the job carries the same row shape as a PR-event job; the queue consumer then
 * runs it with the full {github, env, db, job, runId} context (db + runId are
 * what let the handler persist a run-output artifact). Owns its delivery row:
 * one command comment = one delivery = one job.
 */
export function createCommandJob(db, event, kind, now) {
  return createPrJob(db, event, kind, { ownsDelivery: true }, now);
}

export async function getJob(db, jobId) {
  return first(prepare(db, `${JOB_BASE} WHERE j.job_id = ?`, jobId));
}

/**
 * Returns the newest pull-request head recorded by webhook ingestion. Context
 * gatherers use this immediately before committing their R2 snapshot so an
 * older queue delivery cannot replace context for a newer synchronize event.
 */
export async function getCurrentPullRequestHead(db, repositoryId, prNumber) {
  if (!db?.prepare || repositoryId == null || prNumber == null) return null;
  const row = await first(
    prepare(
      db,
      `SELECT head_sha
         FROM pull_requests
        WHERE repository_id = ? AND pr_number = ?`,
      repositoryId,
      prNumber,
    ),
  );
  return typeof row?.head_sha === 'string' ? row.head_sha : null;
}

export async function getJobByDelivery(db, deliveryId, kind) {
  return kind
    ? jobByDeliveryKind(db, deliveryId, kind)
    : first(prepare(db, `${JOB_BASE} WHERE j.delivery_id = ?`, deliveryId));
}
