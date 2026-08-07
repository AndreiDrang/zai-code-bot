---
type: Workflow
title: PR-context gather pipeline
description: Eager gather of PR task context into per-PR R2 keys (overwritten on each new head) and a KV pr-card; the blob tier consumed by the heavy review/impact/ask/explain handlers.
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
main worker enqueues a `pr_context` job alongside the preview; the heavy worker
gathers the PR's task context (changed files, diff, commits, description,
comments) into **per-PR** R2 keys and a small KV pr-card. The context is a
living snapshot of the PR — each new head overwrites it — and the matching
**readers** (the context-aware review/impact/ask/explain handlers) ship with it
(anti-write-only rule).

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
2. **Idempotency check** — read the existing per-PR manifest
   (`R2.get(prContextKey(repo, pr, 'manifest'))`) and parse its `headSha`. Skip
   (return `same_head_manifest_exists`) only if it equals this job's head — a
   redelivery of the same commit. A different head means a newer commit landed;
   fall through and overwrite the snapshot. `get` (not `head`) is used because
   the head stamp lives inside the manifest.
3. Fetch all context slices in parallel (best-effort; a slice failure degrades
   but does not abort): `getPullRequest`, `getPrFiles`, `getPrDiff`,
   `getPrCommits`, `getPrComments`.
4. **Diff fallback** — GitHub refuses the unified `.diff` media type for PRs
   over 300 files (HTTP 406, "diff too_large"). When the unified diff comes
   back empty, it is reconstructed from the per-file `patch` fields the
   List-Files API already returned (GitHub's own recommendation). The manifest
   records `diffSource ∈ {unified, reconstructed, none}` so consumers can tell
   a real diff from a reconstructed/partial one.
5. Trim to budget — diff to `maxContextBytes`, files/commits/comments to caps.
   Commits store the **full message** (`title` subject line + `message` body),
   not just the first line.
6. Write five context objects to R2 under per-PR keys
   `v1/prs/{repo}/{pr}/context/{files,diff,commits,description,comments}`, then
   write the `manifest` **last** (the commit marker + index; carries `headSha`).
7. Write the **pr-card** to KV (`prCardKey(repo, pr)`) — the PR shape with a
   `contextReady` flag and the context prefix; 30-day TTL.
8. Mark the job succeeded and `ack`.

# Idempotency

Per-PR, skip-same-head: the manifest is the commit marker, written only after
all slices land, and records which head it describes. A gather whose head
equals the stored manifest's head short-circuits (a redelivery); any other head
overwrites the snapshot in place. A crash before the manifest is written leaves
the gather retryable — no false "already gathered", and a retry re-fetches and
overwrites every slice.

Per-delivery: `UNIQUE(delivery_id, kind)` makes a second `pr_context` job for
the same delivery a no-op.

# Consumers (the readers)

- **`/zai review`** — reads the KV pr-card (head), the R2 manifest, and the
  diff/description/files slices to build a bounded review prompt; calls Z.ai and
  publishes a marker-idempotent review comment. Falls back to a live
  `getPrDiff` when the diff slice is missing or empty.
- **`/zai impact`** — reads the pr-card + manifest to surface a context-aware
  "what's gathered" summary (LLM call pending).
- **`/zai ask`, `/zai explain`** — read the pr-card to include the PR shape in
  their notice without calling `getPullRequest`.

The read helpers (`readPrCard`, `readContextManifest`, `readContextSlice`,
`renderContextSummary`, `renderPrCardShape`) live in `shared/pr-context-reader.js`
and are all best-effort: a KV/R2 miss or outage returns null and the caller
degrades.

# Outcomes

| Outcome | Job status | R2/KV written? |
| --- | --- | --- |
| Success (new or newer head) | `succeeded` | Yes (context + card overwritten) |
| Redelivery (manifest head === job head) | `succeeded` (`skipped`) | No |
| Slice failure (partial) | `succeeded` | Yes (degraded — manifest records gaps) |
| Retryable failure (attempts 1–2) | `retryable` | No (manifest not yet written → re-gather) |

# Relationships

- Depends on the [storage authority model](/architecture/storage-authority-model.md)
  (R2 = per-PR context blob tier; KV = read-through card).
- Created by the [PR-preview pipeline](/workflows/pr-preview-pipeline.md) main-worker
  step (both jobs share a delivery).
- Follows the [job lifecycle](/state/job-lifecycle.md); rides the same
  [queue message](/contracts/queue-message.md) format.
- Output retained by [R2 retention](/rules/r2-retention.md) (lifecycle rule on `v1/prs/`).
