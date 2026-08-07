---
type: Dataset
title: D1 storage schema
description: The nine authoritative D1 tables (migrations 0001–0003) that hold all job, delivery, run, artifact, publication, and configuration state.
source_paths:
  - poc/workers/zai-main-worker/migrations/0001_storage_foundation.sql
  - poc/workers/zai-main-worker/migrations/0002_storage_hardening.sql
  - poc/workers/zai-main-worker/migrations/0003_pr_closed_by.sql
confidence: observed
status: current
tags:
  - datasets
  - d1
  - schema
---

# D1 storage schema

D1 (`bot-db`) is the single source of truth. The schema is defined across three
SQL migrations applied via `wrangler d1 migrations apply`. All timestamps are
UTC ISO-8601 strings.

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

# Migration 0002 hardening

Migration `0002_storage_hardening.sql` added bounded leases and restructured
publications:

- `jobs.lease_expires_at`, `jobs.last_failure_at` — bounded lease columns.
- `idx_jobs_status_lease` — supports expired-lease reclaim.
- `idx_runs_job_attempt` (unique) — enforces one run per `(job_id, attempt)`.
- `comment_publications` restructured from per-`(repo, pr, kind, head_sha)` to
  per-`(repo, pr, kind)` to enforce the one-live-comment policy, with
  `status`, `lease_job_id`, `lease_expires_at` columns.

# Migration 0003 — closed-by tracking

Migration `0003_pr_closed_by.sql` added `pull_requests.closed_by TEXT` — the
webhook `sender` who closed the PR, used to render the idempotent "PR closed by
@X" lifecycle comment. NULL for open PRs; preserved across non-close events via
`COALESCE(excluded.closed_by, pull_requests.closed_by)` in the `pull_requests`
UPSERT (GitHub's PR API does not expose `closed_by`, so it is captured once
from the webhook).

# Key constraints

- `jobs.delivery_id` is `UNIQUE` — one job per delivery (idempotent).
- `jobs.kind ∈ ('pr_preview', 'review', 'impact')`.
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

# Relationships

- Underpins the entire [storage authority model](/architecture/storage-authority-model.md).
- The [job lifecycle](/state/job-lifecycle.md) and
  [comment publication](/state/comment-publication.md) concepts describe the
  state machines that operate on these tables.
