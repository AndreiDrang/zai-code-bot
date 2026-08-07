---
type: Workflow
title: Command routing
description: classifyCommand splits /zai commands into light (inline, no LLM) or heavy (async, LLM call) based on a static allowlist.
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

The router answers one question: does a `/zai` command run inline in the
[webhook request](/workflows/webhook-ingress.md) or asynchronously on the
heavy worker? The answer depends on whether the command makes an LLM API call,
not on its category or complexity.

# Classification

Classification is a static array lookup — the single source of truth lives in
`shared/constants.js` and is applied by `classifyCommand()` in `router.js`:

| Bucket | Commands | Why |
| --- | --- | --- |
| **light** | `help` | Pure formatting, no LLM call — completes within the ~10s webhook budget |
| **heavy** | `ask`, `explain`, `describe`, `review`, `impact` | Each makes a Z.ai LLM call — must run async on the heavy worker |
| unsupported | anything else | Valid `/zai` syntax but unknown command |

To reclassify a command, move it between the two arrays — nothing else changes.

# Why classification is by cost, not category

`ask`, `explain`, and `describe` were initially misclassified as light because
they produce short text. But all three call the Z.ai chat-completions API
(`https://api.z.ai/...`), which can exceed the webhook deadline. Only `help` is
truly light. This was corrected so the routing reflects execution cost.

# Handler interfaces

Light and heavy handlers use **different interfaces**, so moving a command
between buckets requires recreating the handler, not just editing the array:

- **Light handlers** receive `{ github, env, parsed, event }` where
  `event.repository.owner.login` is available.
- **Heavy handlers** receive `{ github, env, db, job, runId }` with a D1 job
  row and the GitHub payload.

# Current handler status

| Command | Bucket | Status |
| --- | --- | --- |
| `help` | light | ✅ implemented |
| `ask` | heavy | 🟡 stub |
| `explain` | heavy | 🟡 stub |
| `describe` | heavy | 🟡 stub |
| `review` | heavy | 🟡 stub (legacy service-binding path) |
| `impact` | heavy | 🟡 stub (legacy service-binding path) |

The migration plan is to route all heavy commands through the same durable
Queue + D1 + R2 path as `pr_preview`.

# Relationships

- Called by [webhook ingress](/workflows/webhook-ingress.md) after the gate
  chain.
- Heavy commands that are still stubs use the legacy service-binding delegation
  (part of the [two-worker split](/architecture/two-worker-split.md)).
