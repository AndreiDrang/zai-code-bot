---
type: Architecture
title: Storage authority model
description: D1 is the source of truth for all job, delivery, and publication state; R2 holds immutable artifacts; KV is a non-authoritative cache; the Queue is a transport.
source_paths:
  - poc/workers/shared/storage/config.js
  - poc/workers/shared/storage/database.js
  - poc/workers/shared/storage/keys.js
  - poc/workers/zai-main-worker/wrangler.toml
  - poc/workers/zai-heavy-worker/wrangler.toml
  - poc/README.md
confidence: observed
status: current
tags:
  - architecture
  - storage
---

# Storage authority model

Four Cloudflare resources serve distinct, non-overlapping roles. The critical
invariant is that **D1 is authoritative** and every other store is either
immutable, a transport, or a best-effort derivative.

# Resource roles

| Resource | Binding | Role | Authoritative? |
| --- | --- | --- | --- |
| D1 database | `BOT_DB` (`bot-db`) | Jobs, deliveries, runs, publications, configs — all transactional state | **Yes** |
| R2 bucket | `BOT_ARTIFACTS` (`bot-storage`) | Large immutable artifacts (PR manifests, preview results) | Immutable (write-once) |
| Queue | `BOT_JOBS` (`bot-jobs`) | Async transport for job IDs | No (transport only) |
| KV namespace | `BOT_CACHE` (`bot-cache`) | Derived cache (repo config, preview bodies) | No (best-effort) |

# KV non-authoritativeity

KV is **never** the source of truth. Every KV write is derived from a D1 read
or a completed publication, and every KV access is wrapped in a `try/catch`
that swallows errors:

- A KV outage must not change repository policy or retry a completed job.
- KV cache keys are **versioned** so stale entries are harmless rather than
  incorrect. Deleting a stale key is an optimization, not a correctness
  requirement.
- Preview bodies cached in KV are a TTL convenience; the canonical body lives
  in R2 and D1 (`comment_publications.body_artifact_id`).

# Versioned key scheme

All R2 and KV keys are prefixed with the storage schema version (`v1/` for R2,
`v1:` for KV). This enables [30-day retention](/rules/r2-retention.md) via a
single R2 lifecycle rule on the `v1/` prefix and allows future schema changes
without invalidating in-flight data.

# Relationships

- The [D1 storage schema](/datasets/d1-storage-schema.md) defines the
  authoritative tables.
- The [PR-preview pipeline](/workflows/pr-preview-pipeline.md) writes to all
  four resources in a specific order.
- The [transactional outbox](/contracts/transactional-outbox.md) bridges D1
  commits to Queue publishes.
