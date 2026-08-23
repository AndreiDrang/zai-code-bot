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

## Workers

| Worker | Owns | Driven by |
| --- | --- | --- |
| `zai-main-worker` | webhook ingress, signature gate, parse, auth, routing, incremental slice refreshes, D1 write + queue publish, 5-min self-healing cron | `fetch` (webhook) + `scheduled` (cron) |
| `zai-heavy-worker` | queue consumer, job claiming, `pr_context` / `pr_summary` / `review` / `describe` handlers, artifact + context writes, comment publication | `queue` (consumer) |

## Decoupled lifetimes

The durable command path is decoupled so neither worker holds the other alive:

1. Main writes the job to D1, publishes a minimal queue message, and returns
   `202 Accepted` — all within the webhook request.
2. Heavy consumes the queue message on its own lifetime and claims the job via a
   bounded lease.

## Relationships

- Main's [webhook ingress](/workflows/webhook-ingress.md) is the entry point
  for all events.
- [Command routing](/workflows/command-routing.md) sends both supported
  commands across the Queue boundary.

## Open Questions

- None. Deployment topology is fixed: the main worker serves
  `zai-worker.tokenbel.info` (custom domain); the heavy worker has
  `workers_dev = false` and no public ingress — it is reachable only through
  the `bot-jobs` Queue consumer.
