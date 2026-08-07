-- Storage foundation (consolidated).
--
-- This single migration captures the full PoC storage schema, merging the
-- original 0001–0004 steps (foundation, hardening, pr closed_by, pr_context
-- job kind) into one authoritative create-from-scratch file. All timestamps are
-- UTC ISO-8601 strings.
--
-- D1 notes for future migrations:
--   * The D1 query API rejects explicit BEGIN/COMMIT/SAVEPOINT ([7500]);
--     wrangler runs each statement on its own.
--   * D1 enforces foreign keys UNCONDITIONALLY — `PRAGMA foreign_keys = OFF` is
--     ignored. Rebuilding an FK-parent table therefore requires clearing its
--     referencing child rows first; prefer additive (ALTER TABLE ADD COLUMN /
--     CREATE INDEX) changes whenever possible.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- repositories
CREATE TABLE IF NOT EXISTS repositories (
  repository_id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT,
  config_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ------------------------------------------------------------- pull_requests
-- closed_by (webhook sender) is captured once on PR close — GitHub's PR API
-- does not expose it. NULL for open PRs; preserved across non-close events via
-- COALESCE in the pull_requests UPSERT (shared/storage/deliveries.js).
CREATE TABLE IF NOT EXISTS pull_requests (
  repository_id INTEGER NOT NULL REFERENCES repositories(repository_id),
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  title TEXT,
  author_login TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  closed_by TEXT,
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, pr_number)
);

-- -------------------------------------------------------- webhook_deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  action TEXT NOT NULL,
  repository_id INTEGER NOT NULL REFERENCES repositories(repository_id),
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload_artifact_id TEXT,
  payload_sha256 TEXT
);

-- ---------------------------------------------------------------------- jobs
-- A webhook delivery may spawn more than one job (pr_preview + pr_context for
-- the same head); the composite UNIQUE(delivery_id, kind) keeps the same
-- (delivery, kind) pair race-safe. lease_expires_at/last_failure_at bound worker
-- leases.
CREATE TABLE IF NOT EXISTS jobs (
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
  lease_expires_at TEXT,
  last_failure_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(delivery_id, kind)
);

-- ---------------------------------------------------------------- job_outbox
CREATE TABLE IF NOT EXISTS job_outbox (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  published_at TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_publish_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ------------------------------------------------------------ analysis_runs
CREATE TABLE IF NOT EXISTS analysis_runs (
  run_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'retryable', 'succeeded', 'failed')),
  model TEXT,
  prompt_version TEXT,
  started_at TEXT,
  completed_at TEXT,
  result_artifact_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ----------------------------------------------------------------- artifacts
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- ----------------------------------------------------- comment_publications
-- One live publication per repository/PR/kind. current_head_sha replaces the
-- original head_sha-in-PK design so the newest publication is retained per key;
-- lease_job_id/lease_expires_at serialize concurrent publishers.
CREATE TABLE IF NOT EXISTS comment_publications (
  repository_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  comment_kind TEXT NOT NULL,
  current_head_sha TEXT,
  github_comment_id INTEGER,
  marker TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('publishing', 'published')),
  lease_job_id TEXT,
  lease_expires_at TEXT,
  body_artifact_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, pr_number, comment_kind)
);

-- -------------------------------------------------------- repository_configs
CREATE TABLE IF NOT EXISTS repository_configs (
  repository_id INTEGER PRIMARY KEY REFERENCES repositories(repository_id),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  auto_preview INTEGER NOT NULL DEFAULT 1 CHECK (auto_preview IN (0, 1)),
  max_files INTEGER NOT NULL DEFAULT 100,
  max_context_bytes INTEGER NOT NULL DEFAULT 200000,
  retention_profile TEXT NOT NULL DEFAULT 'default',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

-- -------------------------------------------------------------------- indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status_lease ON jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON job_outbox(published_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_expiry ON artifacts(expires_at);
CREATE INDEX IF NOT EXISTS idx_runs_job ON analysis_runs(job_id, attempt);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_job_attempt ON analysis_runs(job_id, attempt);
