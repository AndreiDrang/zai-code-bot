---
type: Entity
title: One-live-comment publication
description: Exactly one bot comment per (repository, PR, comment_kind) is kept live and updated across pushes via a D1 publication lease.
source_paths:
  - poc/workers/shared/comments.js
  - poc/workers/zai-main-worker/migrations/0001_storage_foundation.sql
  - poc/workers/zai-heavy-worker/src/handlers/pr-preview.js
  - poc/workers/zai-heavy-worker/src/handlers/review.js
confidence: observed
status: current
tags:
  - state
  - comments
  - publication
---

# One-live-comment publication

The bot maintains exactly one live comment per `(repository_id, pr_number,
comment_kind)` triple. Each new push to the same PR updates the existing
comment rather than creating duplicates, so a PR thread never accumulates
stale preview comments.

# Publication state machine

The `comment_publications` table is keyed by
`PRIMARY KEY (repository_id, pr_number, comment_kind)`:

| Status | Meaning |
| --- | --- |
| `publishing` | A job has claimed the publication lease and is building the comment |
| `published` | The comment is live on GitHub; `github_comment_id` is set |

# Publication lease

Before publishing, a job calls `claimPublication()` which atomically reserves
the single row for one job by writing `lease_job_id` and `lease_expires_at`.
This prevents two concurrent jobs (e.g. a stale push and a fresh push) from
both publishing. The winner finalizes via `finalizePublication()`; the loser's
update is a no-op.

# Marker-based lookup

Comments are found by a hidden HTML marker comment (`<!-- zai-pr-preview -->`)
rather than by body text. `findMarkerComment()` searches the bot-owned comments
and, when a `publication.github_comment_id` is known, verifies the marker on
that specific comment first. This makes updates idempotent across retries.

# head_sha freshness

The publication records `current_head_sha`. The [PR-preview pipeline](/workflows/pr-preview-pipeline.md)
verifies that the live PR's `head.sha` still matches the job's `head_sha`
before publishing — if a newer push arrived, the job returns `superseded` and
the newer job's publication wins.

# Comment kinds

Each `(repository_id, pr_number, comment_kind)` is an independently maintained
live comment:

| `comment_kind` | Marker | Published by | Purpose |
| --- | --- | --- | --- |
| `pr_preview` | `<!-- zai-pr-preview -->` | PR-preview pipeline | Metadata-only identity brief, updated across pushes |
| `pr_closed` | `<!-- zai-pr-closed -->` | [Closed lifecycle](/workflows/pr-preview-pipeline.md#closed-lifecycle) | One-time "PR closed by @X" announcement |
| `review` | `<!-- zai-review -->` | [/zai review handler](/workflows/command-routing.md) | LLM code review, updated across re-runs on the same PR |

Both share the same publication-lease machinery and the
[unified footer](/rules/comment-footer.md).

# Preview body

The published preview is a **metadata-only** identity card (repository, PR
number, title, author, head SHA) rendered by `renderPrPreview()`. No per-file
data is computed or stored — the brief never shows files changed, additions, or
deletions. Like every bot comment, it ends with the
[unified bot comment footer](/rules/comment-footer.md) before the hidden
marker.

# Relationships

- Used by the [PR-preview pipeline](/workflows/pr-preview-pipeline.md) as its
  final step.
- Schema is defined in the [D1 storage schema](/datasets/d1-storage-schema.md).
- The marker constants live in `shared/constants.js`.
