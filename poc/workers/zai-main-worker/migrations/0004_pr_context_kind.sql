-- Phase B: register the `pr_context` job kind and let a single webhook delivery
-- produce more than one job (pr_preview + pr_context for the same head).
--
-- Two schema changes vs 0001:
--   1. kind CHECK gains 'pr_context' (plus the already-listed 'review','impact')
--   2. the single-column `delivery_id UNIQUE` becomes a composite
--      `UNIQUE(delivery_id, kind)` — a delivery may now spawn multiple job
--      kinds, but the same (delivery, kind) pair stays unique (race-safe
--      idempotency, enforced by the index, not just the app pre-check).
--
-- SQLite cannot ALTER a CHECK constraint or drop a column-level UNIQUE in place,
-- so the `jobs` table must be rebuilt. D1 adds two hard constraints:
--   * the D1 query API rejects explicit BEGIN/COMMIT/SAVEPOINT ([7500]); each
--     statement runs on its own.
--   * D1 enforces foreign keys UNCONDITIONALLY — `PRAGMA foreign_keys = OFF` is
--     ignored. `jobs` is an FK parent (job_outbox, analysis_runs, artifacts all
--     reference jobs(job_id)), so a rebuild-via-copy cannot `DROP TABLE jobs`
--     while those children hold rows (the implicit DELETE trips their FK).
--
-- Resolution: `jobs` and its three dependents are all TRANSIENT (queue state +
-- analysis history + publish history). A clean wipe is the only D1-compatible
-- way to rebuild the FK parent; the next webhook repopulates jobs and the
-- dependents accrue anew. (This is a one-time PoC migration.)

PRAGMA foreign_keys = ON;

-- 1. Clear the FK children that block dropping/rebuilding `jobs`.
DELETE FROM analysis_runs;
DELETE FROM artifacts;
DELETE FROM job_outbox;

-- 2. Drop any `jobs_new` left behind by the earlier failed copy-rebuild
--    attempts, then the old `jobs` table (now safe: nothing references it).
DROP TABLE IF EXISTS jobs_new;
DROP TABLE jobs;

-- 3. Recreate `jobs` with the widened kind CHECK and the composite uniqueness.
CREATE TABLE jobs (
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

CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at);
