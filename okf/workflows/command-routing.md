---
type: Workflow
title: Command routing
description: Routes help inline and the two LLM commands to durable Queue jobs; only `created` comment actions may execute a command.
source_paths:
  - src/shared/constants.js
  - src/zai-main-worker/src/router.js
  - src/zai-main-worker/src/index.js
  - src/shared/commands.js
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
| `help` | main Worker (inline) | Lists the supported commands without creating a job |
| `review` | durable Queue job | Agent-mode [LLM review](/workflows/llm-command-execution.md) over the gathered snapshot; marker-owned review comment |
| `describe` | durable Queue job | Commit-message description via direct LLM call; marker-owned PR-body section + status comment |

`LIGHT_COMMANDS` is empty for LLM work. Help is the only inline command path
(help posts/updates its own `zai-help`-marked comment); there is no legacy
service-binding fallback. For review and describe, the main Worker validates
the webhook, authorizes the commenter, creates a D1 job, publishes
`{ schemaVersion, jobId }`, and returns `202`.

Any other command remains syntactically parseable for a safe
unsupported-command response but is not in `AVAILABLE_COMMANDS` and cannot
reach a handler.

## Action gating

Only `created` comment actions may execute a command
(`COMMAND_TRIGGER_ACTIONS` in `comment-events.js`). `issue_comment.edited`
and `.deleted` deliveries still carry the full comment body, but re-running
the LLM on them would trigger exactly what the user tried to retract, so the
command gate skips them with a plain `200`. The comments-slice mirror
intentionally still refreshes on all three actions — a deletion must
propagate to the conversation snapshot even though execution must not. A
missing `action` degrades to `created` (GitHub always sends one).

## Command job creation

Unlike PR-event jobs, a command arrives on an `issue_comment`, which carries
no head SHA. `createCommandDurableJob()` resolves the PR head via
`getPullRequest()` so the job row matches a PR-event job's shape — the
[stale-head guards](/workflows/pr-context-pipeline.md) then apply uniformly.
One command comment = one delivery = one job (`UNIQUE(delivery_id, kind)`).
Durable routing additionally requires a PR comment (`issue.pull_request`
present) and both `BOT_DB` and `BOT_JOBS` bindings; otherwise `503`.

## Handler contract

The Queue consumer dispatches by kind (`handlers/index.js`) — `review`,
`describe`, `pr_context`, `pr_summary` — and calls each handler with:

```text
{ github, env, db, job, runId }
```

An unknown kind fails non-retryably (`unsupported_job_kind`). D1 owns the
job lease and publication state. R2 is derivative and stores gathered
context plus the latest command result.

## Relationships

- Review/describe execution is defined by
  [LLM command execution](/workflows/llm-command-execution.md).
- Jobs follow the [job lifecycle](/state/job-lifecycle.md); queue payloads
  follow the [queue message format](/contracts/queue-message.md).
