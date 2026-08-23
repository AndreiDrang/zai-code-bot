---
type: Dataset
title: D1 storage schema
description: The nine authoritative D1 tables — created by migration 0001 and evolved by 0002 (command surface) and 0003 (pr_summary job kind) — holding all job, delivery, run, artifact, publication, and configuration state.
source_paths:
  - src/zai-main-worker/migrations/0001_storage_foundation.sql
  - src/zai-main-worker/migrations/0002_command_surface.sql
  - src/zai-main-worker/migrations/0003_pr_summary_job.sql
confidence: observed
status: current
tags:
  - datasets
  - d1
  - schema
---

# D1 storage schema

D1 (`bot-db`) is the single source of truth. The schema is applied via
`wrangler d1 migrations apply`: `0001_storage_foundation.sql` creates the
foundation; `0002` and `0003` evolve it. All timestamps are UTC ISO-8601
strings.

# Migration history

| Migration | Change | Mechanism |
| --- | --- | --- |
| `0001_storage_foundation.sql` | Creates all nine tables, indexes, constraints | `CREATE TABLE IF NOT EXISTS` |
| `0002_command_surface.sql` | Narrowed `jobs.kind` to the supported surface (`pr_context`, `review`, `describe`) | Rebuild of `jobs` + child tables |
| `0003_pr_summary_job.sql` | Added `pr_summary` to `jobs.kind` | Rebuild of `jobs` + child tables |

Because SQLite/D1 cannot alter a `CHECK` constraint in place, migrations
0002 and 0003 each rebuild `jobs` **together with its child tables**
(`job_outbox`, `analysis_runs`, `artifacts`) via create-copy-drop-rename,
preserving all rows. Deployed migrations are never edited in place — 0001
was consolidated only before first deploy.

# Tables

| Table | Grain | Role |
| --- | --- | --- |
| `repositories` | one per GitHub repo | Repo identity + config version pointer |
| `pull_requests` | `(repository_id, pr_number)` | Latest known PR state (head SHA, title, author, `state`, `closed_by`) |
| `webhook_deliveries` | one per GitHub delivery ID | Idempotent delivery deduplication |
| `jobs` | one per job UUID | [Job lifecycle](/state/job-lifecycle.md) + attempt tracking + lease |
| `job_outbox` | one per job | [Transactional outbox](/contracts/transactional-outbox.md) |
| `analysis_runs` | `(job_id, attempt)` unique | Per-attempt execution record |
| `artifacts` | one per artifact UUID | R2 artifact metadata + `expires_at` |
| `comment_publications` | `(repository_id, pr_number, comment_kind)` | [One-live-comment](/state/comment-publication.md) publication lease |
| `repository_configs` | one per repo | Per-repo policy (enabled, maxFiles, `maxContextBytes`, retention profile) |

# Key constraints

- `UNIQUE(delivery_id, kind)` on `jobs` — the same (delivery, kind) pair is
  race-safe idempotent; this is what lets one `pull_request` delivery own
  both a `pr_context` job and its derived `pr_summary` job.
- `jobs.kind ∈ ('pr_context', 'pr_summary', 'review', 'describe')` — the two
  internal pipeline jobs plus the two user commands.
- `jobs.status ∈ ('queued', 'running', 'retryable', 'succeeded', 'failed', 'cancelled')`.
- `artifacts.r2_key` is `UNIQUE`.
- `comment_publications.status ∈ ('publishing', 'published')`.

# Indexes

| Index | Supports |
| --- | --- |
| `idx_jobs_status_available` | Claimable-job lookup |
| `idx_jobs_status_lease` | Expired-lease reclaim |
| `idx_outbox_due` | Outbox replay |
| `idx_artifacts_expiry` | Retention sweep |
| `idx_runs_job` / `idx_runs_job_attempt` | Run history (unique per attempt) |

# D1 migration constraints

Two D1 limitations shape the migration approach (documented in the 0001
header):

- D1 rejects explicit `BEGIN`/`COMMIT`/`SAVEPOINT` in migration SQL (error
  `[7500]`); wrangler applies each statement in sequence.
- D1 ignores `PRAGMA foreign_keys = OFF` — FK enforcement is always active,
  so child tables must be rebuilt in lockstep with `jobs`.

# Relationships

- Underpins the entire [storage authority model](/architecture/storage-authority-model.md).
- The [job lifecycle](/state/job-lifecycle.md) and
  [comment publication](/state/comment-publication.md) concepts describe the
  state machines that operate on these tables.
