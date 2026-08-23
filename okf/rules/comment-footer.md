---
type: Business Rule
title: Unified bot comment footer
description: Every bot comment ends with the identical shared BOT_FOOTER attribution — "Powered by AndreiDrang, Z.ai and Cloudflare Workers" — placed before the hidden marker.
source_paths:
  - src/shared/constants.js
  - src/shared/commands.js
  - src/shared/comments.js
confidence: observed
status: current
tags:
  - rules
  - comments
  - footer
---

# Unified bot comment footer

Every command comment the bot posts ends with the same attribution, so review
and describe results have consistent branding.

# Footer text

The footer is a single shared constant, `BOT_FOOTER` in
`shared/constants.js`, interpolated by each message producer before its hidden
HTML marker:

> *Powered by [AndreiDrang](https://github.com/AndreiDrang), [Z.ai](https://z.ai) and [Cloudflare Workers](https://cloudflare.com)*

Rendered in Markdown it reads: **Powered by AndreiDrang, Z.ai and Cloudflare Workers**.

# Rules

- There is exactly one source of truth: the `BOT_FOOTER` constant. Message
  producers interpolate it; none hard-code the attribution string.
- The footer precedes the message's hidden marker, so the marker stays the last
  parseable token.
- Review and describe status/result comments apply it.

# Relationships

- The [one-live-comment publication](/state/comment-publication.md) emits
  footer-terminated bodies.
- The hidden markers that the footer precedes are documented under
  [comment publication](/state/comment-publication.md).
