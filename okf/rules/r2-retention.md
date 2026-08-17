---
type: Business Rule
title: 30-day R2 retention
description: R2 objects expire after 30 days. The two R2 grains are retained differently — context (v2/prs/) by an R2 lifecycle rule, run-outputs (v1/runs/) by the D1-indexed app sweep with the lifecycle rule as backstop.
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

All R2 objects expire after a uniform **30-day** retention window. The two
R2 grains ([storage authority model](/architecture/storage-authority-model.md))
are retained by different mechanisms, because one has a D1 index and the
other does not.

# Grain 1 — PR context (`v2/prs/`): lifecycle rule only

The gather pipeline writes PR task context (the V2 snapshot: slice kinds,
per-file patches, command results, and `pr-summary.json`) under
`v2/prs/{repo}/{pr}/context/…` — keyed per PR, latest snapshot overwritten
on each new head. These objects are **not** indexed in D1 (the key is
deterministic from the PR identity), so there is no D1 row to sweep.
Retention is solely an **R2 lifecycle rule** on the `v2/prs/` prefix:

- 30-day expiry, applied via the Cloudflare Dashboard, R2 S3 API, or IaC.
- It **cannot** be declared in `wrangler.toml` — both workers document the
  apply command in a comment block:
  `npx wrangler r2 bucket lifecycle add bot-storage --id pr-context-retention --prefix "v2/prs/" --expire-days 30`.

# Grain 2 — run-outputs (`v1/runs/`): D1-indexed sweep + lifecycle backstop

Run-outputs (LLM `response.json`-style artifacts, keyed by job/run) **are**
indexed by the `artifacts` table. `artifactExpiresAt()` sets each row's
`expires_at` to `now + retentionDays` (`R2_ARTIFACT_RETENTION_DAYS = 30` in
`shared/storage/artifacts.js`), and the
[cron self-healing sweep](/workflows/cron-self-healing.md) runs
`deleteExpiredArtifacts()` / `sweepExpiredStorage()` every 5 minutes to
delete the R2 object and its D1 row together — keeping the index consistent.

# Open Questions

- Unknown/discrepancy: both `wrangler.toml` files set
  `R2_RETENTION_DAYS = "180"` in `[vars]`, while the documented bucket
  lifecycle rule, the comment blocks, and the application constant
  (`R2_ARTIFACT_RETENTION_DAYS = 30`) all say **30**. The variable is not
  read by any code path (the sweep uses the constant), so the drift is
  currently cosmetic, but it should be reconciled to 30 or the intended
  window restated.

# Applies to

- `v2/prs/**` — the PR-context snapshot tier (lifecycle rule).
- `v1/runs/**` — D1-indexed run-outputs (app sweep + backstop).
- `v1/deliveries/**` — delivery payloads ride the same expiry window.

The bot's published comments live on GitHub + D1, **not** in R2. The KV PR
card uses a 30-day TTL that matches this window.

# Relationships

- Enforced partly by the [cron self-healing sweep](/workflows/cron-self-healing.md)
  (run-outputs) and partly by the bucket lifecycle rule (context).
- Context objects are written by the [PR-context gather pipeline](/workflows/pr-context-pipeline.md).
- Key versioning is part of the [storage authority model](/architecture/storage-authority-model.md).
