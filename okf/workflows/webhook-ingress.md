---
type: Workflow
title: Webhook ingress
description: The main worker fetch() gate chain — method, content-type, signature verification, parse, and routing dispatch.
source_paths:
  - poc/workers/zai-main-worker/src/index.js
  - poc/workers/shared/crypto.js
  - poc/workers/shared/secrets.js
confidence: observed
status: current
tags:
  - workflow
  - webhooks
---

# Webhook ingress

The `fetch(request, env, ctx)` handler in the main worker is the single entry
point for all GitHub webhooks. It runs a strict gate chain before any business
logic, returning early at each gate.

# Gate chain

| # | Gate | Failure response |
| --- | --- | --- |
| 1 | HTTP method is `POST` | `405 Method Not Allowed` |
| 2 | Content-Type is `application/json` | `415 Unsupported Media Type` |
| 3 | Webhook signature valid (HMAC-SHA256 via Web Crypto) | `401 Unauthorized` |
| 4 | Event is command-bearing `/zai` comment | `200 OK` (skip) |
| 5 | Commenter is a [collaborator](/rules/authorization.md) | `403 Forbidden` |

# Signature verification

Gate 3 uses the Web Crypto API (`crypto.subtle`) — no `nodejs_compat` flag
needed. The webhook secret is resolved via `resolveSecretValue()` because
Secrets Store bindings can surface as `string | {get()} | Promise`; resolving
to a plain string before HMAC prevents the secret from stringifying to
`"[object Object]"` and failing every check.

# Dispatch after the gates

Once past the gates, the handler forks by event type:

- **Pull request events** (`opened`, `reopened`, `synchronize`,
  `ready_for_review`) enter the [PR-context pipeline](/workflows/pr-context-pipeline.md)
  — they never reach the command parser. Main returns `202 Accepted`.
- **Command comments** are classified by [command routing](/workflows/command-routing.md)
  into light (inline) or heavy (delegated).

# Relationships

- Depends on the [two-worker split](/architecture/two-worker-split.md) for
  deciding inline vs. async.
- Depends on [authorization](/rules/authorization.md) for the collaborator gate.

# Open Questions

- None.
