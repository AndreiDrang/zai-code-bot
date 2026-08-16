---
type: Entity
title: One-live-comment publication
description: Exactly one marker-owned bot comment per repository, PR, and command kind is kept live through a D1 publication lease.
source_paths:
  - poc/workers/shared/comments.js
  - poc/workers/shared/constants.js
  - poc/workers/zai-heavy-worker/src/handlers/review.js
  - poc/workers/zai-heavy-worker/src/handlers/describe.js
confidence: observed
status: current
tags:
  - state
  - comments
  - publication
---

# One-live-comment publication

The bot maintains one live comment per `(repository_id, pr_number,
comment_kind)`. `review` and `describe` results therefore update their existing
marker-owned comment instead of creating duplicates across Queue retries.

## Publication lease

`claimPublication()` atomically reserves the row with `lease_job_id` and
`lease_expires_at`. The winner publishes or updates the GitHub comment and
calls `finalizePublication()`. A concurrent loser skips publication, while an
expired lease can be reclaimed by a later job.

## Markers

| Comment kind | Marker | Purpose |
|---|---|---|
| `review` | `<!-- zai-review -->` | Latest LLM code review |
| `describe` | `<!-- zai-describe -->` | Latest describe command status |

The `describe` command also uses `zai-description-start` and
`zai-description-end` markers inside the PR body so it never overwrites
user-authored content.

## Relationships

- Schema: [D1 storage schema](/datasets/d1-storage-schema.md)
- Routing: [Command routing](/workflows/command-routing.md)
- Shared footer: [comment footer](/rules/comment-footer.md)
