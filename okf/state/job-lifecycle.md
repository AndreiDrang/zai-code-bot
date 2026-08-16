---
type: Entity
title: Job lifecycle and bounded leases
description: The durable job state machine (queued → running → succeeded/retryable/failed) with bounded leases that prevent duplicate concurrent execution.
source_paths:
  - poc/workers/shared/storage/jobs.js
  - poc/workers/zai-main-worker/migrations/0001_storage_foundation.sql
  - poc/workers/zai-heavy-worker/src/queue.js
confidence: observed
status: current
tags:
  - state
  - jobs
  - leases
---

# Job lifecycle and bounded leases

Every durable unit of work is a `jobs` row in D1. Its lifecycle is a strict
state machine, and concurrent execution is prevented by bounded leases.

# State machine

```
queued ──claim──▶ running ──ok──▶ succeeded
  ▲                  │
  │                  ├─retryable─▶ (delay) ──▶ queued
  │                  │
  │                  ├─failed──▶ failed (terminal)
  │                  │
  └──lease expired───┘  (cron reclaim)
```

| Status | Meaning |
| --- | --- |
| `queued` | Created, waiting for a consumer to claim it |
| `running` | A consumer claimed it and holds an active lease |
| `retryable` | A recoverable failure occurred; will be re-queued after a delay |
| `succeeded` | Handler completed without error (terminal) |
| `failed` | Attempt budget exhausted or non-retryable error (terminal) |
| `cancelled` | Superseded or administratively cancelled (terminal) |

# Bounded lease

When a consumer calls `claimJob()`, D1 atomically transitions the job to
`running` and writes `lease_expires_at = now + 600s` (10 minutes). The claim
succeeds only if the job is currently claimable (not already `running` with an
unexpired lease, and not terminal).

Constants:

- `MAX_JOB_ATTEMPTS = 3`
- `JOB_LEASE_SECONDS = 600` (10 minutes)

# Expired-lease recovery

If a worker crashes after claiming, the job stays `running` forever. The
[cron self-healing sweep](/workflows/cron-self-healing.md) finds jobs where
`status = 'running' AND lease_expires_at < now` and either requeues them (under
the attempt budget) or fails them permanently via `recoverExpiredJob()`.

# Analysis runs

Each execution attempt is recorded as an `analysis_runs` row linked to the job,
tracking `attempt`, `status`, `model`, `prompt_version`, `result_artifact_id`,
and `error_code`. There is a unique index on `(job_id, attempt)`.

# Relationships

- Transition logic is driven by the [retry budget](/rules/retry-budget.md).
- The [PR-context gather pipeline](/workflows/pr-context-pipeline.md) and
  [command routing](/workflows/command-routing.md) are the job producers.
  A delivery creates one `pr_context`, `review`, or `describe` job
  (`UNIQUE(delivery_id, kind)`).
- Schema is defined in the [D1 storage schema](/datasets/d1-storage-schema.md).
