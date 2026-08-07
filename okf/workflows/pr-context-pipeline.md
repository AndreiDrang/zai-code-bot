---
type: Workflow
title: PR-context gather pipeline
description: Eager gather of PR task context into deterministic R2 keys and a KV pr-card on each new head SHA; the blob tier consumed by the heavy review/impact/ask/explain handlers.
source_paths:
  - poc/workers/zai-main-worker/src/index.js
  - poc/workers/zai-main-worker/src/pr-events.js
  - poc/workers/shared/storage/deliveries.js
  - poc/workers/shared/storage/keys.js
  - poc/workers/shared/github.js
  - poc/workers/zai-heavy-worker/src/handlers/pr-context.js
  - poc/workers/shared/pr-context-reader.js
  - poc/workers/tests/pr-context.test.js
confidence: observed
status: current
tags:
  - workflow
  - pr-context
  - gather
---

# PR-context gather pipeline

The **writer** half of the PR-context tier. On a head-producing PR event the
main worker enqueues a `pr_context` job alongside the preview; the heavy
worker gathers the PR's task context (changed files, diff, commits,
description, comments) into deterministic R2 keys and a small KV pr-card. The
matching **readers** — the context-aware review/impact/ask/explain handlers —
ship with it (anti-write-only rule).

# Trigger

A `pull_request` webhook whose action is in `CONTEXT_TRIGGER_ACTIONS`:
`opened`, `reopened`, `synchronize`, `ready_for_review`. `edited` (title) and
`closed` carry no new content, so no context job is created for them. The
preview job is always created; the context job is created alongside it on the
same delivery.

# Steps

**Main worker (within the webhook request):**

1. After `createPrPreviewJob()`, call `createPrContextJob()` — a second `jobs`
   row (kind `pr_context`) on the same `webhook_deliveries` row, reusing the
   repository/PR/delivery rows via INSERT OR IGNORE. Idempotent on
   `(delivery_id, 'pr_context')`.
2. Publish a `{ jobId }` queue message for the context job (separate delivery
   from the preview job's).

**Heavy worker (on its own lifetime):**

1. Claim the `pr_context` job via the bounded lease.
2. **Idempotency check** — `R2.head(prContextKey(repo, pr, head, 'manifest'))`.
   If a manifest already exists for this head, return `skipped` without
   fetching (a redelivery lost to a prior gather).
3. Fetch all context slices in parallel (best-effort; a slice failure degrades
   but does not abort): `getPullRequest`, `getPrFiles`, `getPrDiff`,
   `getPrCommits`, `getPrComments`.
4. Trim to budget — diff to `maxContextBytes`, files/commits/comments to caps.
5. Write five context objects to R2 under deterministic keys
   `v1/prs/{repo}/{pr}/{head}/context/{files,diff,commits,description,comments}`,
   then write the `manifest` **last** (the idempotency marker + index).
6. Write the **pr-card** to KV (`prCardKey(repo, pr)`) — the PR shape with a
   `contextReady` flag and the context prefix; 30-day TTL.
7. Mark the job succeeded and `ack`.

# Idempotency

Per-head: the manifest is the commit marker, written only after all slices
land. A crash before it leaves the gather retryable — no false "already
gathered". A redelivery finds the manifest present and short-circuits.

Per-delivery: `UNIQUE(delivery_id, kind)` (migration 0004) makes a second
`pr_context` job for the same delivery a no-op.

# Consumers (the readers)

- **`/zai review`, `/zai impact`** — read the KV pr-card to resolve the head,
  then the R2 manifest, and surface a context-aware "what's gathered" summary
  (the LLM call lands in the review feature).
- **`/zai ask`, `/zai explain`** — read the pr-card to include the PR shape in
  their notice without calling `getPullRequest`.

The read helpers (`readPrCard`, `readContextManifest`, `renderContextSummary`,
`renderPrCardShape`) live in `shared/pr-context-reader.js` and are all
best-effort: a KV/R2 miss or outage returns null and the caller degrades.

# Outcomes

| Outcome | Job status | R2/KV written? |
| --- | --- | --- |
| Success (new head) | `succeeded` | Yes (context + card) |
| Redelivery (manifest exists) | `succeeded` (`skipped`) | No |
| Slice failure (partial) | `succeeded` | Yes (degraded — manifest records gaps) |
| Retryable failure (attempts 1–2) | `retryable` | No (manifest not yet written → re-gather) |

# Relationships

- Depends on the [storage authority model](/architecture/storage-authority-model.md)
  (R2 = context blob tier; KV = read-through card).
- Created by the [PR-preview pipeline](/workflows/pr-preview-pipeline.md) main-worker
  step (both jobs share a delivery).
- Follows the [job lifecycle](/state/job-lifecycle.md); rides the same
  [queue message](/contracts/queue-message.md) format.
- Output retained by [R2 retention](/rules/r2-retention.md) (lifecycle rule on `v1/prs/`).
