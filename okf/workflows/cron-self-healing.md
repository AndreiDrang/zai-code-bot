---
type: Workflow
title: Cron self-healing sweep
description: The scheduled() handler runs four bounded recovery jobs every 5 minutes — expired-lease reclaim, outbox replay, stranded-job requeue, and R2 retention sweep.
source_paths:
  - poc/workers/zai-main-worker/src/index.js
  - poc/workers/zai-main-worker/src/job-enqueuer.js
  - poc/workers/shared/storage/jobs.js
  - poc/workers/shared/storage/artifacts.js
confidence: observed
status: current
tags:
  - workflow
  - cron
  - reliability
---

# Cron self-healing sweep

The main worker's `scheduled()` handler runs on a `*/5 * * * *` cron trigger
(every 5 minutes). It executes four independent, bounded recovery jobs so the
system converges to a consistent state without manual intervention.

## The four sweeps

| Sweep | Function | Limit | Purpose |
| --- | --- | --- | --- |
| Lease recovery | `recoverExpiredJobs()` | 100 | Reclaim jobs stuck in `running` past their lease |
| Outbox replay | `replayDueOutbox()` | 25 | Re-publish queue messages for committed-but-unpublished jobs |
| Stranded-job requeue | `requeueStrandedJobs()` | 25 | Re-enqueue `queued`/`retryable` jobs ≥2 min past `available_at` |
| Retention sweep | `sweepExpiredStorage()` | 100 | Delete R2 artifacts whose `expires_at` has passed |

## Lease recovery

Finds `jobs` in `running` status where `lease_expires_at < now`. For each, it
either requeues the job (if under the [attempt budget](/rules/retry-budget.md))
or marks it permanently `failed`. This handles a worker crash after
[claiming](/state/job-lifecycle.md) but before completing.

## Outbox replay

Finds `job_outbox` rows where `published_at IS NULL` and
`next_attempt_at <= now`. For each, it re-attempts the Queue publish. This is
the safety net for the [transactional outbox](/contracts/transactional-outbox.md):
if the Queue publish fails after the D1 commit, the cron retries it until
success.

## Stranded-job requeue

Finds `queued`/`retryable` jobs whose `available_at` is more than 120 s in
the past — past due, so nothing should be waiting on them — and re-sends a
plain Queue message. This is the safety net for a job whose message was lost
*after* the outbox row was already published once: a queue redelivery that
arrived before `available_at` (clock/scheduling skew) and was re-delayed but
never redelivered, or a crash between the retryable transition and
`message.retry()`. Duplicate deliveries are harmless: `claimJob` lets only
one delivery win. The outbox row is deliberately untouched (it tracks first
publication only), which is exactly why the outbox replay above cannot cover
this case.

## Retention sweep

Finds `artifacts` where `expires_at < now`, deletes the R2 object, and removes
the D1 row. This is the application-level enforcement of the
[30-day retention policy](/rules/r2-retention.md); it complements (but does not
replace) the R2 lifecycle rule.

## Bounding

Each sweep is bounded (100 / 25 / 25 / 100) so a single cron invocation cannot
exhaust CPU time. The next invocation continues where this one left off.

## Relationships

- Depends on the [job lifecycle](/state/job-lifecycle.md) and
  [lease](/state/job-lifecycle.md) mechanisms for recovery.
- Depends on the [transactional outbox](/contracts/transactional-outbox.md)
  for replay.
- Enforces [R2 retention](/rules/r2-retention.md) at the application level.
- Part of the [two-worker split](/architecture/two-worker-split.md) — only the
  main worker runs this cron.
