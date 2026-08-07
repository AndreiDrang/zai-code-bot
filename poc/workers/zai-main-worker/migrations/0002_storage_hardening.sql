-- Storage hardening: bounded worker leases and one live comment publication.
PRAGMA foreign_keys = ON;

ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN last_failure_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_status_lease ON jobs(status, lease_expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_job_attempt ON analysis_runs(job_id, attempt);

-- SQLite cannot remove head_sha from an existing primary key in place. Preserve
-- the newest publication per repository/PR/kind while replacing the table.
CREATE TABLE comment_publications_v2 (
  repository_id INTEGER NOT NULL,
  pr_number INTEGER NOT NULL,
  comment_kind TEXT NOT NULL,
  current_head_sha TEXT,
  github_comment_id INTEGER,
  marker TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('publishing', 'published')),
  lease_job_id TEXT,
  lease_expires_at TEXT,
  body_artifact_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, pr_number, comment_kind)
);

INSERT INTO comment_publications_v2
  (repository_id, pr_number, comment_kind, current_head_sha,
   github_comment_id, marker, status, body_artifact_id, created_at, updated_at)
SELECT repository_id, pr_number, comment_kind, head_sha,
       github_comment_id, marker, 'published', body_artifact_id, created_at, updated_at
FROM comment_publications AS source
WHERE source.rowid = (
  SELECT candidate.rowid
  FROM comment_publications AS candidate
  WHERE candidate.repository_id = source.repository_id
    AND candidate.pr_number = source.pr_number
    AND candidate.comment_kind = source.comment_kind
  ORDER BY candidate.updated_at DESC, candidate.rowid DESC
  LIMIT 1
);

DROP TABLE comment_publications;
ALTER TABLE comment_publications_v2 RENAME TO comment_publications;
