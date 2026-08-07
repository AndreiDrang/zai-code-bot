---
type: Workflow
title: PR-context gather pipeline
description: The writer side of the PR-context tier — a full eager gather (on each new head) plus incremental single-slice refreshes (comments on issue_comment, description on PR body edit) that keep the per-PR R2 keys + KV pr-card fresh between gathers; consumed by the heavy review/impact/ask/explain handlers.
source_paths:
  - poc/workers/zai-main-worker/src/index.js
  - poc/workers/zai-main-worker/src/pr-events.js
  - poc/workers/shared/storage/deliveries.js
  - poc/workers/shared/storage/keys.js
  - poc/workers/shared/github.js
  - poc/workers/zai-heavy-worker/src/handlers/pr-context.js
  - poc/workers/shared/pr-context-reader.js
  - poc/workers/shared/pr-comments.js
  - poc/workers/shared/pr-description.js
  - poc/workers/zai-main-worker/src/comment-events.js
  - poc/workers/tests/pr-context.test.js
  - poc/workers/tests/pr-comments.test.js
  - poc/workers/tests/pr-description.test.js
confidence: observed
status: current
tags:
  - workflow
  - pr-context
  - gather
---

# PR-context gather pipeline

The **writer** half of the PR-context tier, with two modes that share the same
per-PR R2 keys (`v1/prs/{repo}/{pr}/context/{kind}`):

- **Full gather** (heavy worker, on each new head) — re-captures every slice
  (files, diff, commits, description, comments) + the KV pr-card. This is the
  Trigger / Steps / Idempotency / Outcomes flow below.
- **Incremental slice refresh** (main worker, on edit events) — refreshes a
  SINGLE slice between gathers so the heavy readers see fresh conversation and
  description without waiting for a push. See
  [Incremental slice refresh](#incremental-slice-refresh-between-gathers).

The context is a living snapshot of the PR — each new head overwrites it — and
the matching **readers** (the context-aware review/impact/ask/explain handlers)
ship with the gather (anti-write-only rule).

# Trigger

A `pull_request` webhook whose action is in `CONTEXT_TRIGGER_ACTIONS`:
`opened`, `reopened`, `synchronize`, `ready_for_review`. `edited` and `closed`
do NOT spawn a full gather job — but a body edit (`changes.body`) triggers an
[incremental description refresh](#incremental-slice-refresh-between-gathers)
instead, so the description slice stays fresh without a push. The preview job is
always created; the context job is created alongside it on the same delivery
(head-producing actions only).

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

# Incremental slice refresh (between gathers)

Edit events keep individual slices fresh without a full re-gather. The main
worker schedules a best-effort, non-blocking `ctx.waitUntil(...)` write — no D1
job, no queue round-trip (the refresh is light: one GitHub fetch or zero, plus a
single R2 `put`). Errors are swallowed; the slice is derivative and the next
gather re-captures it from scratch.

| Trigger | Slice | Source | API call? |
| --- | --- | --- | --- |
| `issue_comment` created/edited/deleted on a PR | `comments` | `getPrComments` (full conversation) | Yes — one webhook carries one comment, not the whole thread |
| `pull_request.edited` with `changes.body` | `description` | `payload.pull_request.body` | **No** — the edited webhook carries the new body in-payload |

**Why two writers are safe.** Each slice has ONE projection, shared by the full
gather and its incremental refresh, so last-writer-wins on the single R2 key
always leaves a consistent slice:

- `comments` — `projectComments(raw)` (`shared/pr-comments.js`): issue
  `{user, body, created_at, updated_at}` + review `{user, body, path, line,
  updated_at}`. `updated_at` is kept so edits are visible. The gather imports
  the same function — the two writers can never drift in shape.
- `description` — the PR `body` string (`pullRequest.body || ''`). Both writers
  store the identical source value.

**Idempotency.** The comments refresh is a full re-fetch, so a webhook
re-delivery writes identical bytes (never appends or duplicates — the property
that makes full-refresh correct where an insert-one path would duplicate). The
description refresh writes the deterministic payload body. A refresh racing the
gather is safe: same key, same projection → whichever lands last is a valid
snapshot.

**Limitation — manifest counts lag.** The incremental refresh deliberately
does NOT touch `manifest.json` (single-key `put`, no read-modify-write, so it
can't race the gather). The manifest's derived counters — `counts.issueComments`
/ `counts.reviewComments`, written by the gather from the same comments slice —
therefore go stale between a comments refresh and the next push. The only reader
of those counts is `renderContextSummary`'s coverage line ("**N commits**, **N
comments"): the `/zai impact` stub shows it, and `/zai review` prints it as a
decorative note while reading the actual `diff`/`description`/`files` slices
directly (so the review content itself is always fresh). The stale count is
cosmetic and self-heals on the next gather; fixing it would require a racy
read-modify-write on the manifest, which isn't worth it.

**Predicates.** `isPrCommentRefreshEvent` / `planCommentsRefresh`
(`main/comment-events.js`) and `isPrDescriptionEditEvent` /
`planDescriptionRefresh` (`main/pr-events.js`) are pure and unit-tested without
the fetch handler.

# Relationships

- Depends on the [storage authority model](/architecture/storage-authority-model.md)
  (R2 = per-PR context blob tier; KV = read-through card).
- Created by the [PR-preview pipeline](/workflows/pr-preview-pipeline.md) main-worker
  step (both jobs share a delivery).
- Follows the [job lifecycle](/state/job-lifecycle.md); rides the same
  [queue message](/contracts/queue-message.md) format.
- Output retained by [R2 retention](/rules/r2-retention.md) (lifecycle rule on `v1/prs/`).
