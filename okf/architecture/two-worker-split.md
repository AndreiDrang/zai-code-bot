---
type: Architecture
title: Two-worker split
description: The main worker acknowledges webhooks instantly; the heavy worker runs async work on its own lifetime budget.
source_paths:
  - poc/workers/zai-main-worker/src/index.js
  - poc/workers/zai-heavy-worker/src/index.js
  - poc/workers/shared/constants.js
  - poc/README.md
confidence: observed
status: current
tags:
  - architecture
  - workers
---

# Two-worker split

GitHub webhooks time out if a `200` is not returned within ~10 seconds. PR
analysis and any LLM-backed command **cannot** complete inline within that
window. The POC splits execution across two Workers so the main worker can
acknowledge instantly while the heavy worker runs to completion on its own CPU
and wall-time budget, driven by a durable [Queue](/contracts/queue-message.md).

# Workers

| Worker | Owns | Driven by |
| --- | --- | --- |
| `zai-main-worker` | webhook ingress, signature gate, parse, auth, routing, D1 write + queue publish, 5-min self-healing cron | `fetch` (webhook) + `scheduled` (cron) |
| `zai-heavy-worker` | queue consumer, job claiming, artifact writes, one-live-comment publish | `queue` (consumer) + `fetch` (legacy service binding) |

# Decoupled lifetimes

The durable PR-preview path uses a **double-decouple** so neither worker holds
the other alive:

1. Main writes the job to D1, publishes a minimal queue message, and returns
   `202 Accepted` — all within the webhook request.
2. Heavy consumes the queue message on its own lifetime, claims the job via a
   bounded lease, and runs the handler in `ctx.waitUntil`.

There is also a **legacy service-binding** path where main delegates heavy
commands via a token-gated `fetch` to heavy's `/handle` endpoint. Both workers
use their own `ctx.waitUntil` so main is never held alive waiting for heavy.

# Relationships

- Main's [webhook ingress](/workflows/webhook-ingress.md) is the entry point
  for all events.
- The [PR-preview pipeline](/workflows/pr-preview-pipeline.md) is the primary
  durable flow that spans both workers.
- [Command routing](/workflows/command-routing.md) decides whether a `/zai`
  command stays inline or crosses the worker boundary.
- The worker-to-worker token is a shared secret (`ZAI_INTERNAL_TOKEN`) used
  only on the legacy service-binding path, not the queue path.

# Open Questions

- Unknown: The final deployment topology (single route vs. split domains) is
  not yet finalized.
