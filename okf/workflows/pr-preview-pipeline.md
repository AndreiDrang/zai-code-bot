---
type: Workflow
title: Durable PR-preview pipeline
description: End-to-end flow from a pull_request webhook through D1 job creation, queue publish, heavy-worker processing, R2 artifact writes, and one-live-comment publication.
source_paths:
  - poc/workers/zai-main-worker/src/index.js
  - poc/workers/zai-main-worker/src/pr-events.js
  - poc/workers/shared/storage/deliveries.js
  - poc/workers/zai-heavy-worker/src/queue.js
  - poc/workers/zai-heavy-worker/src/handlers/pr-preview.js
  - poc/workers/shared/comments.js
  - poc/workers/shared/pr-preview.js
  - poc/workers/tests/pr-preview-sync.test.js
  - poc/workers/tests/pr-preview-closed.test.js
confidence: observed
status: current
tags:
  - workflow
  - pr-preview
  - pipeline
---

# Durable PR-preview pipeline

The flagship flow of the POC. When a `pull_request` webhook arrives, the main
worker records it durably and acknowledges instantly; the heavy worker later
builds and publishes a bounded markdown preview. The flow spans both workers
across the [two-worker split](/architecture/two-worker-split.md).

# Trigger

A `pull_request` webhook with one of these actions: `opened`, `reopened`,
`synchronize`, `ready_for_review`, `edited` (title changes only), or `closed`.
These events **never** enter the command parser — they are detected early and
routed directly to storage.

# Steps

**Main worker (within the webhook request):**

1. Verify the webhook [signature](/workflows/webhook-ingress.md).
2. Extract the PR event (`deliveryId`, `repositoryId`, `prNumber`, `headSha`).
3. Call `createPrPreviewJob()` — atomically insert the `webhook_deliveries`
   row, the `jobs` row, and the `job_outbox` row in a single D1 batch. If the
   delivery ID already exists, the job is returned as a duplicate (idempotent).
4. Publish a minimal [queue message](/contracts/queue-message.md) `{ jobId }`.
5. Return `202 Accepted` with `{ jobId, duplicate }`.

**Heavy worker (on its own lifetime):**

1. Consume the queue message and [claim](/state/job-lifecycle.md) the job via
   a bounded lease.
2. Start an `analysis_runs` row for this attempt.
3. Verify `head_sha` freshness — call `getPullRequest` and confirm
   `pull_request.head.sha` still matches `job.head_sha`. If a newer push
   arrived, the job returns `superseded` and succeeds without publishing
   (the newer push's job wins). This is the **only** GitHub fetch the preview
   makes; no per-file data is read.
4. Render the **metadata-only** preview body via `renderPrPreview()` — just
   repository, PR number, title, author, and head SHA, terminated by the
   [unified bot comment footer](/rules/comment-footer.md).
5. Write the `result` artifact (the rendered markdown) to R2 (immutable,
   30-day retention) and link it to the run.
6. [Publish or update the one-live comment](/state/comment-publication.md)
   via a D1 publication lease.
7. Cache the body in KV (best-effort, TTL 1h).
8. Mark the job succeeded and `ack` the queue message.

# Closed lifecycle

A `closed` action rides the same durable pipeline but takes a distinct branch
in the heavy worker. When `job.state === 'closed'`, the handler renders
`renderPrClosed({ closedBy })` — a one-time "PR closed by @X" announcement —
and publishes it under `commentKind = 'pr_closed'` (marker
`<!-- zai-pr-closed -->`). The supersede `getPullRequest` is skipped (head SHA
is irrelevant for a close) and the metadata preview comment is left untouched.
`closed_by` is the webhook `sender` (who closed the PR), captured in
`extractPullRequestEvent` and persisted on `pull_requests.closed_by` (migration
0003); GitHub's PR API does not expose it. The same publication lease keeps the
close comment idempotent across redelivery.

# Failure handling

Any exception during steps 2–6 triggers the [retry budget](/rules/retry-budget.md):
attempts 1–2 schedule a retryable delay; attempt 3 marks the job `failed` and
acks. If the worker crashes after claiming, the [cron self-healing sweep](/workflows/cron-self-healing.md)
reclaims the expired lease.

# Outcomes

| Outcome | Job status | Comment published? |
| --- | --- | --- |
| Success | `succeeded` | Yes (one live comment updated or created) |
| Superseded by newer push | `succeeded` | No (newer job wins) |
| Disabled repo / preview | `succeeded` | No |
| Retryable failure (attempts 1–2) | `retryable` | No (will retry) |
| Terminal failure (attempt 3) | `failed` | No |

# Relationships

- Depends on the [storage authority model](/architecture/storage-authority-model.md)
  and the [transactional outbox](/contracts/transactional-outbox.md).
- Writes artifacts subject to [R2 retention](/rules/r2-retention.md).
- Uses the [job lifecycle](/state/job-lifecycle.md) state machine throughout.
