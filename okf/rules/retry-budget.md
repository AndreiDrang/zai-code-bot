---
type: Business Rule
title: Three-attempt retry budget
description: Jobs get at most 3 execution attempts — two warnings then a terminal failure with an error log — with exponential backoff between retries.
source_paths:
  - poc/workers/zai-heavy-worker/src/queue.js
  - poc/workers/shared/storage/jobs.js
confidence: observed
status: current
tags:
  - rules
  - retry
  - reliability
---

# Three-attempt retry budget

Durable jobs are allowed at most **3 execution attempts**. There is no dead-letter
queue — D1 is the permanent journal of failures.

# Attempt outcomes

| Attempt | Outcome | Queue action | Log level |
| --- | --- | --- | --- |
| 1 (fail) | `retryable` + delayed retry | `message.retry({ delaySeconds })` | `warn` |
| 2 (fail) | `retryable` + delayed retry | `message.retry({ delaySeconds })` | `warn` |
| 3 (fail) | `failed` + `operation_failed` error code | `message.ack()` | `error` |

The budget is evaluated as `error?.retryable !== false && attempt_count < 3`.
A handler can force a non-retryable failure immediately by setting
`error.retryable = false` (e.g. an unsupported job kind).

# Backoff

Retryable attempts use exponential backoff:

```text
delaySeconds = min(300, 2 ^ attempt_count × 10)
```

So attempt 1 → 20s, attempt 2 → 40s, capped at 300s (5 minutes).

# Terminal failure

On attempt 3 (or any non-retryable error), the job is marked `failed` with
error code `operation_failed`, logged at `error` level with the original cause
code, and the queue message is **acked**. The job row remains in D1 as a
permanent failure record — there is no DLQ.

# State-transition safety

If D1 cannot record the state transition (e.g. `markJobRetryable` or
`markJobFailed` throws), the queue message is **retried** (`message.retry` with
a 30s delay) rather than acked. This prevents a job from being silently lost
when the database is unavailable.

# Relationships

- Drives the [job lifecycle](/state/job-lifecycle.md) state machine.
- Enforced in the heavy worker's queue consumer
  ([PR-context pipeline](/workflows/pr-context-pipeline.md)).
- No DLQ by design — see the [storage authority model](/architecture/storage-authority-model.md).
