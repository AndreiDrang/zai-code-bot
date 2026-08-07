-- Storage foundation. All timestamps are UTC ISO-8601 strings.
PRAGMA foreign_keys = ON;

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

CREATE TABLE IF NOT EXISTS pull_requests (
  repository_id INTEGER NOT NULL REFERENCES repositories(repository_id),
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  base_sha TEXT,
  title TEXT,
  author_login TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, pr_number)
);

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

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL UNIQUE REFERENCES webhook_deliveries(delivery_id),
  kind TEXT NOT NULL CHECK (kind IN ('pr_preview', 'review', 'impact')),
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
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_outbox (
  job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
  published_at TEXT,
  publish_attempts INTEGER NOT NULL DEFAULT 0,
  last_publish_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS comment_publications (
  repository_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  comment_kind TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  github_comment_id INTEGER NOT NULL,
  marker TEXT NOT NULL,
  body_artifact_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, pr_number, comment_kind, head_sha)
);

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

CREATE INDEX IF NOT EXISTS idx_jobs_status_available ON jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON job_outbox(published_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_expiry ON artifacts(expires_at);
CREATE INDEX IF NOT EXISTS idx_runs_job ON analysis_runs(job_id, attempt);
