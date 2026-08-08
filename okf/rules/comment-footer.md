---
type: Business Rule
title: Unified bot comment footer
description: Every bot comment ends with the identical shared BOT_FOOTER attribution — "Powered by AndreiDrang, Z.ai and Cloudflare Workers" — placed before the hidden marker.
source_paths:
  - poc/workers/shared/constants.js
  - poc/workers/shared/commands.js
  - poc/workers/shared/pr-preview.js
confidence: observed
status: current
tags:
  - rules
  - comments
  - footer
---

# Unified bot comment footer

Every comment the bot posts ends with the same attribution, so a PR thread has
consistent, unmistakable branding regardless of which path produced the
message — preview, `/zai` command reply, help text, stub notice, or error.

# Footer text

The footer is a single shared constant, `BOT_FOOTER` in
`shared/constants.js`, interpolated by each message producer before its hidden
HTML marker:

> *Powered by [AndreiDrang](https://github.com/AndreiDrang), [Z.ai](https://z.ai) and [Cloudflare Workers](https://cloudflare.com)*

Rendered in Markdown it reads: **Powered by AndreiDrang, Z.ai and Cloudflare Workers**.

# Rules

- There is exactly one source of truth: the `BOT_FOOTER` constant. Message
  producers interpolate it; none hard-code the attribution string.
- The footer precedes the message's hidden marker (e.g.
  `<!-- zai-pr-preview -->`), so the marker stays the last parseable token.
- All message paths apply it: the PR preview (`renderPrPreview`), command
  replies and help (`formatHelp`, `formatCommandNotAvailable`), the heavy stub
  notices (`ask`/`explain`/`describe`/`review`/`impact`), and the error
  comments in both workers (the `help` error, the unauthorized-command notice,
  and the heavy-command failure comment).

# Relationships

- The [Durable PR-preview pipeline](/workflows/pr-preview-pipeline.md) and the
  [one-live-comment publication](/state/comment-publication.md) both emit
  footer-terminated bodies.
- The hidden markers that the footer precedes are documented under
  [comment publication](/state/comment-publication.md).
