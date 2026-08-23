---
type: Workflow
title: PR-context gather pipeline
description: Gathers a V2 per-PR snapshot (per-file patches, files index, commits, description, comments) into R2, rejects stale heads, and schedules the pr_summary job.
source_paths:
  - src/zai-heavy-worker/src/handlers/pr-context.js
  - src/shared/pr-context-reader.js
  - src/shared/pr-comments.js
  - src/shared/pr-description.js
  - src/shared/github.js
  - src/shared/context/context-limits.js
  - src/zai-main-worker/src/pr-events.js
confidence: observed
status: current
tags:
  - workflow
  - context
  - r2
---

# PR-context gather pipeline

On `pull_request` `opened`, `reopened`, `synchronize`, and `ready_for_review`,
the main worker creates one `pr_context` job (`CONTEXT_TRIGGER_ACTIONS`).
The heavy worker fetches the PR and writes a **V2 snapshot** to R2 under
`v2/prs/{repositoryId}/{prNumber}/context/`:

```text
manifest.json     # written LAST — the complete-snapshot commit marker
files.json        # ALL changed files across GitHub pagination, with per-file diff state
commits.json      # up to 100 commits with full messages (subject + body)
description.md    # PR body
comments.json     # issue + review comments (shared projection)
diffs/<path>.patch  # ONE patch object per changed text file (URL-encoded path)
```

A KV **PR card** (head, title, author, counts, `contextReady`,
`contextStorageVersion: 2`, 30-day TTL) is keyed by `(repo, pr)` — not head —
so command handlers read the PR shape without calling `getPullRequest`.

## Diff budgets

Per-file patches are stored independently and never truncated
(`shared/context/context-limits.js`):

- **1 MiB max per file patch** (`MAX_SNAPSHOT_FILE_DIFF_BYTES`) — larger
  patches are skipped with reason `file_diff_too_large`.
- **20 MiB max total stored patches** (`MAX_SNAPSHOT_TOTAL_DIFF_BYTES`) —
  further files are skipped with `snapshot_diff_budget_exceeded`.
- Binary or patch-less files are skipped with `binary_file` /
  `patch_unavailable`; invalid paths with `invalid_path`.

A skipped artifact is recorded **explicitly** in `files.json` as
`diff: { state, reason, bytes }`; nothing is silently dropped. `files.json`
indexes every changed file because the gather paginates the GitHub files API
(`getAllPrFiles`, 100 per page).

## Manifest as commit marker

The manifest (`schemaVersion: 2`) is written **last**. It stamps `headSha`,
`baseSha`, aggregates, per-kind counts, `diffsAvailable`/`diffsUnavailable`,
and the applied limits. Because R2 is strongly consistent, a reader (or the
`pr_summary` job published after the write) sees a complete snapshot whenever
the manifest is readable. A redelivery whose committed manifest already
describes the same head is a no-op (`skipped: same_head_manifest_exists`).

## Stale-head rejection

Queue deliveries are at-least-once and `synchronize` events for one PR can
overlap, so an older delivery must never overwrite a newer head's context. The
handler returns `status: 'stale'` (job succeeds, no write) when any check
finds a newer head:

1. **Pre-flight D1 check** — `getCurrentPullRequestHead()` reads the newest
   head recorded by webhook ingestion.
2. **GitHub head check** — the fetched PR's `head.sha` must equal the job's
   `head_sha`.
3. **D1 re-check before the writes.**
4. **Post-commit manifest re-read** — if another head won the write race, the
   delivery neither summarizes nor advertises the stale snapshot.

## pr_summary scheduling

After the manifest commits, the gather creates an idempotent
[pr_summary job](/workflows/pr-summary-job.md) that shares the originating
delivery (`UNIQUE(delivery_id, kind)`), and attempts an immediate Queue
publish through the heavy worker's own producer binding; on failure the
D1 [outbox](/contracts/transactional-outbox.md) replay remains the recovery
path.

## Incremental refreshes

Between gathers, the main worker keeps two derivative slices fresh via
best-effort `ctx.waitUntil` writes (raw `bucket.put`, manifest untouched):

- `issue_comment` `created`/`edited`/`deleted` on a PR triggers a full
  re-fetch of the conversation (`refreshCommentsSlice`) that overwrites
  `comments.json` using the gather's shared projection.
- `pull_request.edited` with `changes.body` writes `description.md` straight
  from the payload body — no API call.

Known limitation: the manifest's derived `counts.issueComments` /
`counts.reviewComments` lag between a refresh and the next gather; only
presentation surfaces read them, and the next gather self-heals them.

## Readers

All consumption goes through the [Context Service](/contracts/agent-context-tools.md)
DTO layer (`shared/context/context-service.js`): it validates the manifest
head against an expected head, exposes metadata/files/diff/comment readers,
and builds the bounded combined-diff view used by prompt builders.

- [LLM command execution](/workflows/llm-command-execution.md) — review runs
  agent-mode over the snapshot; describe reads `commits.json` with a live
  GitHub fallback.
- [pr_summary job](/workflows/pr-summary-job.md) — summarizes the snapshot
  into structured auxiliary context.

## Relationships

- Triggered by the [webhook ingress](/workflows/webhook-ingress.md) PR-event
  branch; follows the [job lifecycle](/state/job-lifecycle.md).
- Writes the R2 context tier described by the
  [storage authority model](/architecture/storage-authority-model.md);
  retention follows [R2 retention](/rules/r2-retention.md).
