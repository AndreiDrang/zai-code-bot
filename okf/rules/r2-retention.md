---
type: Business Rule
title: 30-day R2 retention
description: All v1/-prefixed R2 objects expire after 30 days, enforced by an R2 lifecycle rule (not Wrangler) and complemented by an application-level sweep.
source_paths:
  - poc/workers/shared/storage/artifacts.js
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

All R2 artifacts expire after a uniform **30-day** retention window. This keeps
storage bounded without manual cleanup. Retention is enforced at two layers.

# Layer 1 — R2 lifecycle rule (external provisioning)

An R2 bucket lifecycle rule deletes all objects with the `v1/` prefix after 30
days. This is the authoritative retention mechanism.

- **It cannot be declared in `wrangler.toml`** — Wrangler does not support R2
  lifecycle rules. It must be applied via the Cloudflare Dashboard, the R2 S3
  API, or IaC.
- The `R2_RETENTION_DAYS = "30"` environment variable is set in both workers'
  `wrangler.toml` so the application code and the lifecycle rule agree on the
  window.

# Open Questions

- Unknown: The lifecycle rule provisioning artifacts (a lifecycle-rule JSON and
  an S3-API apply script) are referenced in the README but are **not yet
  present** in the repository. They must be created and applied to the
  `bot-storage` bucket before retention is enforced at this layer.

# Layer 2 — Application-level sweep

`artifactExpiresAt()` computes each artifact's `expires_at` as
`now + retentionDays`. The [cron self-healing sweep](/workflows/cron-self-healing.md)
runs `deleteExpiredArtifacts()` / `sweepExpiredStorage()` every 5 minutes to
delete R2 objects and their D1 `artifacts` rows whose `expires_at` has passed.
This complements the lifecycle rule and keeps D1 metadata in sync.

# Applies to

All `v1/`-prefixed objects: delivery payloads, PR file manifests, and analysis
run results (files + rendered markdown). Nothing in the POC is retained beyond
30 days.

# Relationships

- Enforced by the [cron self-healing sweep](/workflows/cron-self-healing.md).
- Artifacts are written by the [PR-preview pipeline](/workflows/pr-preview-pipeline.md).
- Key versioning (`v1/`) is part of the [storage authority model](/architecture/storage-authority-model.md).
