-- Replace the legacy preview/impact job constraint with the supported command
-- surface. This migration is intentionally additive: 0001 is already deployed
-- in existing environments and must not be edited in place.

CREATE TABLE jobs_v2 (
  job_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(delivery_id),
  kind TEXT NOT NULL CHECK (kind IN ('pr_context', 'review', 'describe')),
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

INSERT INTO jobs_v2 (
  job_id, delivery_id, kind, repository_id, pr_number, head_sha, status,
  attempt_count, available_at, claimed_at, completed_at, last_error_code,
  config_version, lease_expires_at, last_failure_at, created_at, updated_at
)
SELECT
  job_id, delivery_id, kind, repository_id, pr_number, head_sha, status,
  attempt_count, available_at, claimed_at, completed_at, last_error_code,
  config_version, lease_expires_at, last_failure_at, created_at, updated_at
FROM jobs
WHERE kind IN ('pr_context', 'review');

CREATE TABLE job_outbox_v2 (
  job_id TEXT PRIMARY KEY REFERENCES jobs_v2(job_id),
  published_at TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_publish_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO job_outbox_v2
SELECT o.*
FROM job_outbox AS o
JOIN jobs_v2 AS j ON j.job_id = o.job_id;

CREATE TABLE analysis_runs_v2 (
  run_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs_v2(job_id),
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

INSERT INTO analysis_runs_v2
SELECT r.*
FROM analysis_runs AS r
JOIN jobs_v2 AS j ON j.job_id = r.job_id;

CREATE TABLE artifacts_v2 (
  artifact_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs_v2(job_id),
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO artifacts_v2
SELECT a.*
FROM artifacts AS a
JOIN jobs_v2 AS j ON j.job_id = a.job_id;

DROP TABLE artifacts;
DROP TABLE analysis_runs;
DROP TABLE job_outbox;
DROP TABLE jobs;

ALTER TABLE jobs_v2 RENAME TO jobs;
ALTER TABLE job_outbox_v2 RENAME TO job_outbox;
ALTER TABLE analysis_runs_v2 RENAME TO analysis_runs;
ALTER TABLE artifacts_v2 RENAME TO artifacts;

CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_jobs_status_lease ON jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON job_outbox(published_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_expiry ON artifacts(expires_at);
CREATE INDEX IF NOT EXISTS idx_runs_job ON analysis_runs(job_id, attempt);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_job_attempt ON analysis_runs(job_id, attempt);
