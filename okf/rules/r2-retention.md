---
type: Business Rule
title: 30-day R2 retention
description: R2 objects expire after 30 days. The two R2 grains are retained differently — context (v1/prs/) by an R2 lifecycle rule, run-outputs (v1/runs/) by the D1-indexed app sweep with the lifecycle rule as backstop.
source_paths:
  - poc/workers/shared/storage/artifacts.js
  - poc/workers/shared/storage/keys.js
  - poc/workers/zai-main-worker/wrangler.toml
  - poc/workers/zai-heavy-worker/wrangler.toml
  - poc/README.md
confidence: observed
status: current
tags:
  - rules
  - retention
  - r2
---

# 30-day R2 retention

All R2 objects expire after a uniform **30-day** retention window. The two R2
grains ([storage authority model](/architecture/storage-authority-model.md))
are retained by different mechanisms, because one has a D1 index and the other
does not.

# Grain 1 — PR context (`v1/prs/`): lifecycle rule only

The gather pipeline writes PR task context under
`v1/prs/{repo}/{pr}/context/{kind}` (keyed per PR — the latest snapshot is
overwritten on each new head). These objects are **not** indexed in D1 (the key
is deterministic from the PR identity), so there is no D1 row to sweep.
Retention is solely an **R2 lifecycle rule** on the `v1/prs/` prefix:

- 30-day expiry, applied via the Cloudflare Dashboard, R2 S3 API, or IaC.
- It **cannot** be declared in `wrangler.toml` — both workers document the
  apply command in a comment block.
- `R2_RETENTION_DAYS = "30"` in both workers' `[vars]` keeps the app and the
  rule agreed on the window.

# Grain 2 — run-outputs (`v1/runs/`): D1-indexed sweep + lifecycle backstop

Run-outputs (the future LLM `response.json`, keyed by job/run) **are** indexed
by the `artifacts` table. `artifactExpiresAt()` sets each row's `expires_at` to
`now + retentionDays`, and the [cron self-healing sweep](/workflows/cron-self-healing.md)
runs `deleteExpiredArtifacts()` / `sweepExpiredStorage()` every 5 minutes to
delete the R2 object and its D1 row together — keeping the index consistent.
The `v1/` lifecycle rule acts as a backstop for anything the sweep misses.

# Open Questions

- Unknown: the lifecycle-rule provisioning artifacts (a lifecycle-rule JSON and
  an S3-API apply script referenced in the README) are **not yet present** in
  the repository. They must be created and applied to the `bot-storage` bucket
  before retention is enforced at the lifecycle layer.

# Applies to

All `v1/`-prefixed objects: PR task context (`v1/prs/`), run-outputs
(`v1/runs/`), and delivery payloads (`v1/deliveries/`). The bot's published
comments live on GitHub + D1, **not** in R2. Nothing in the POC is retained
beyond 30 days.

# Relationships

- Enforced partly by the [cron self-healing sweep](/workflows/cron-self-healing.md)
  (run-outputs) and partly by the bucket lifecycle rule (context).
- Context objects are written by the [PR-context gather pipeline](/workflows/pr-context-pipeline.md).
- Key versioning (`v1/`) is part of the [storage authority model](/architecture/storage-authority-model.md).
