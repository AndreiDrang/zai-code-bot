---
type: Business Rule
title: Collaborator authorization
description: Only repository collaborators may run /zai commands.
source_paths:
  - src/shared/auth.js
  - src/shared/github.js
  - src/zai-main-worker/src/index.js
confidence: observed
status: current
tags:
  - rules
  - authorization
  - security
---

# Collaborator authorization

Before any `/zai` command is dispatched, the commenter must be verified as a
repository collaborator. This is gate 5 in the
[webhook ingress](/workflows/webhook-ingress.md) chain.

# Policy

The Workers policy requires collaborator status:

| Policy | Requires collaborator status |
| Check | `authorizeCommenter()` |

The check runs over the shared GitHub REST client (`shared/github.js`,
`GitHubClient` — the transport both workers use for all GitHub API I/O)
and calls `GET /repos/{owner}/{repo}/collaborators/{username}`:
`204` = collaborator (authorized), `404` = not (unauthorized). Other
HTTP errors propagate as exceptions.

# Centralization

The policy lives in a single shared module (`shared/auth.js`) imported by both
workers, so a future policy change is a one-file edit. The convenience factory
`isAuthorized(env, owner, repo, username)` builds a `GitHubClient` and runs the
check in one call — useful from the heavy worker, which rebuilds a client per
invocation.

# Failure behavior

Unauthorized commenters receive a `403 Forbidden` response and a posted
unauthorized comment. PR context gather events do not pass through this gate;
they are triggered by PR events, not commands.

# Relationships

- Applied as gate 5 in [webhook ingress](/workflows/webhook-ingress.md).
- Precedes [command routing](/workflows/command-routing.md).
