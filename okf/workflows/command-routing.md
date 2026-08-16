---
type: Workflow
title: Command routing
description: Routes the two supported LLM commands to durable Queue jobs.
source_paths:
  - poc/workers/shared/constants.js
  - poc/workers/zai-main-worker/src/router.js
  - poc/workers/zai-main-worker/src/index.js
  - poc/workers/shared/commands.js
confidence: observed
status: current
tags:
  - workflow
  - commands
---

# Command routing

The public command surface is intentionally limited to:

| Command | Route | Result |
| --- | --- | --- |
| `review` | durable Queue job | Full gathered PR context is sent to Z.ai and a marker-owned review comment is upserted |
| `describe` | durable Queue job | Commit messages are sent to Z.ai and a marker-owned section of the PR body is updated |

`LIGHT_COMMANDS` is empty. There is no inline command path and no legacy
service-binding fallback. The main Worker validates the webhook, authorizes the
commenter, creates a D1 job, publishes `{ schemaVersion, jobId }`, and returns
`202`.

Any other command remains syntactically parseable for a safe unsupported-command
response but is not in `AVAILABLE_COMMANDS` and cannot reach a handler.

## Handler contract

The Queue consumer calls handlers with:

```text
{ github, env, db, job, runId }
```

D1 owns the job lease and publication state. R2 is derivative and stores
gathered context plus the latest command result.
