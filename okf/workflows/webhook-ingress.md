---
type: Workflow
title: Webhook ingress
description: The main worker fetch() gate chain — path scoping, method, content-type, signature verification, parse — then a three-way fork: PR-context jobs, incremental slice refreshes, and command comments.
source_paths:
  - src/zai-main-worker/src/index.js
  - src/shared/crypto.js
  - src/shared/secrets.js
  - src/zai-main-worker/src/comment-events.js
  - src/zai-main-worker/src/pr-events.js
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
| 0 | Request path is `/github/webhook` | `404 Not Found` |
| 1 | HTTP method is `POST` | `405 Method Not Allowed` |
| 2 | Content-Type is `application/json` | `415 Unsupported Media Type` |
| 3 | Webhook signature valid (HMAC-SHA256 via Web Crypto) | `401 Unauthorized` |
| 4 | Event is command-bearing `/zai` comment | `200 OK` (skip) |
| 5 | Commenter is a [collaborator](/rules/authorization.md) | `403 Forbidden` |

# Path scoping

Gate 0 scopes ingress to `POST /github/webhook` (`GITHUB_WEBHOOK_PATH` in
`src/index.js`). The GitHub webhook Payload URL must be
`https://<host>/github/webhook`; one trailing slash is tolerated and the query
string is ignored. Anything else — scanners probing the domain root, a stale
pre-path webhook URL — is rejected before any HMAC work or body read.

# Signature verification

Gate 3 uses the Web Crypto API (`crypto.subtle`) — no `nodejs_compat` flag
needed. The webhook secret is resolved via `resolveSecretValue()` because
Secrets Store bindings can surface as `string | {get()} | Promise`; resolving
to a plain string before HMAC prevents the secret from stringifying to
`"[object Object]"` and failing every check.

# Dispatch after the gates

Once past the gates, the handler forks by event type:

1. **PR comment refresh** (`issue_comment` `created`/`edited`/`deleted` on a
   PR, any comment — command or not): a best-effort, non-blocking
   `ctx.waitUntil` full re-fetch overwrites `comments.json`
   ([incremental slice refresh](/workflows/pr-context-pipeline.md#incremental-refreshes)).
2. **PR description refresh** (`pull_request.edited` with `changes.body`):
   writes `description.md` straight from the payload body, no API call.
3. **PR context jobs** (`pull_request` `opened`/`reopened`/`synchronize`/
   `ready_for_review`): enter the
   [PR-context gather pipeline](/workflows/pr-context-pipeline.md) — they
   never reach the command parser. Main returns `202 Accepted` (with
   `duplicate: true` when the `(delivery, kind)` row already existed).
4. **Command comments** are classified by
   [command routing](/workflows/command-routing.md) into help (inline) or
   heavy (delegated).

# Relationships

- Depends on the [two-worker split](/architecture/two-worker-split.md) for
  deciding inline vs. async.
- Depends on [authorization](/rules/authorization.md) for the collaborator
  gate.

# Open Questions

- None.
