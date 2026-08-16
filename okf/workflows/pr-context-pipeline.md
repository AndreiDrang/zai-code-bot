---
type: Workflow
title: PR-context gather pipeline
description: Gathers bounded PR context into R2 and refreshes derivative slices for review and describe.
source_paths:
  - poc/workers/zai-heavy-worker/src/handlers/pr-context.js
  - poc/workers/shared/pr-context-reader.js
  - poc/workers/shared/pr-comments.js
  - poc/workers/shared/pr-description.js
confidence: observed
status: current
tags:
  - workflow
  - context
  - r2
---

# PR-context gather pipeline

On `opened`, `reopened`, `synchronize`, and `ready_for_review`, the main Worker
creates one `pr_context` job. The heavy Worker fetches the PR and writes a
bounded latest snapshot to R2:

```text
files.json
diff.diff
commits.json
description.md
comments.json
manifest.json
```

The manifest is written last and records the head SHA, counts, truncation, and
file aggregates. A manifest for the same head makes a redelivery a no-op.

## Incremental refreshes

An issue comment event refreshes `comments.json`; a pull-request body edit
refreshes `description.md`. These writes are derivative and best-effort. The
next full gather remains the source for a complete snapshot.

## Readers

- `/zai review` reads all context slices and uses the diff as its primary input.
- `/zai describe` reads `commits.json` and falls back to the GitHub commits API
  if the slice is unavailable.

Both handlers bound their prompt input. Missing R2 data degrades to a live
GitHub read where possible instead of exposing a storage error to the user.
