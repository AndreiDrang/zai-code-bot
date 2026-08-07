-- Phase B: register the `pr_context` job kind and let a single webhook delivery
-- produce more than one job (pr_preview + pr_context for the same head).
--
-- SQLite cannot ALTER a CHECK constraint or drop a column-level UNIQUE in place,
-- so the `jobs` table is rebuilt. Two changes vs 0001:
--   1. kind CHECK gains 'pr_context'
--   2. the single-column `delivery_id UNIQUE` becomes a composite
--      `UNIQUE(delivery_id, kind)` — a delivery may now spawn multiple job
--      kinds, but the same (delivery, kind) pair stays unique (race-safe
--      idempotency, enforced by the index, not just the app pre-check).

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE jobs_new (
  job_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(delivery_id),
  kind TEXT NOT NULL CHECK (kind IN ('pr_preview', 'pr_context', 'review', 'impact')),
  repository_id INTEGER NOT NULL REFERENCES repositories(repository_id),
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retryable', 'succeeded', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(delivery_id, kind)
);

INSERT INTO jobs_new (
  job_id, delivery_id, kind, repository_id, pr_number, head_sha, status,
  attempt_count, available_at, claimed_at, completed_at, last_error_code,
  config_version, created_at, updated_at
)
SELECT
  job_id, delivery_id, kind, repository_id, pr_number, head_sha, status,
  attempt_count, available_at, claimed_at, completed_at, last_error_code,
  config_version, created_at, updated_at
FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

-- Recreate the status/available_at lookup index dropped with the old table.
CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at);

COMMIT;

PRAGMA foreign_keys = ON;
