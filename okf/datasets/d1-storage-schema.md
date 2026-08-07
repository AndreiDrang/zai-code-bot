---
type: Dataset
title: D1 storage schema
description: The nine authoritative D1 tables created by a single consolidated migration (0001) that hold all job, delivery, run, artifact, publication, and configuration state.
source_paths:
  - poc/workers/zai-main-worker/migrations/0001_storage_foundation.sql
confidence: observed
status: current
tags:
  - datasets
  - d1
  - schema
---

# D1 storage schema

D1 (`bot-db`) is the single source of truth. The entire schema is created from
scratch by one consolidated migration, `0001_storage_foundation.sql`, applied
via `wrangler d1 migrations apply`. All timestamps are UTC ISO-8601 strings.

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
| `repository_configs` | one per repo | Per-repo policy (enabled, maxFiles, retention profile) |

# Schema features

The single migration creates every table, index, and constraint from scratch.
The features that were once layered in incrementally (formerly migrations
0002–0004) are all present in the initial create:

- **Bounded leases** — `jobs.lease_expires_at`, `jobs.last_failure_at`, and
  `idx_jobs_status_lease` (expired-lease reclaim) exist from creation.
- **One run per attempt** — `idx_runs_job_attempt` (unique) enforces
  `(job_id, attempt)` uniqueness on `analysis_runs`.
- **One-live-comment publications** — `comment_publications` is keyed by
  `(repository_id, pr_number, comment_kind)` (NOT per head), with `status`,
  `lease_job_id`, `lease_expires_at` columns.
- **Closed-by tracking** — `pull_requests.closed_by TEXT` holds the webhook
  `sender` who closed the PR (NULL for open PRs), captured once from the
  webhook because GitHub's PR API does not expose `closed_by`. Preserved across
  non-close events via `COALESCE(excluded.closed_by, pull_requests.closed_by)`
  in the `pull_requests` UPSERT.
- **pr_context job kind** — `jobs.kind ∈ ('pr_preview', 'pr_context', 'review', 'impact')`.
- **Composite delivery uniqueness** — `UNIQUE(delivery_id, kind)` lets one
  webhook delivery spawn multiple job kinds (preview + context) while keeping
  each `(delivery_id, kind)` pair race-safe. `createPrPreviewJob` owns the
  delivery row (plain INSERT); `createPrContextJob` reuses it (INSERT OR IGNORE).

# Key constraints

- `UNIQUE(delivery_id, kind)` on `jobs` — a delivery may spawn multiple job
  kinds (pr_preview + pr_context), but the same (delivery, kind) pair is unique
  (race-safe idempotency).
- `jobs.kind ∈ ('pr_preview', 'pr_context', 'review', 'impact')`.
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
| `idx_runs_job` / `idx_runs_job_attempt` | Run history |

# D1 migration notes

D1 imposes two constraints that shaped the single-migration approach (both are
documented in the migration header):

- D1 rejects explicit `BEGIN`/`COMMIT`/`SAVEPOINT` in migration SQL (error
  `[7500]`); wrangler applies each statement in sequence.
- D1 ignores `PRAGMA foreign_keys = OFF` — FK enforcement is always active, so
  a table-rebuild-by-copy migration must handle child-table FK references
  directly. The consolidated migration creates from scratch (no rebuild of a
  populated parent), so it sidesteps this footgun entirely for fresh inits.

# Relationships

- Underpins the entire [storage authority model](/architecture/storage-authority-model.md).
- The [job lifecycle](/state/job-lifecycle.md) and
  [comment publication](/state/comment-publication.md) concepts describe the
  state machines that operate on these tables.
