---
type: Architecture
title: Storage authority model
description: D1 is the source of truth for all job, delivery, and publication state; R2 holds PR task context (blobs); KV is a read-through cache; the Queue is a transport.
source_paths:
  - poc/workers/shared/storage/config.js
  - poc/workers/shared/storage/database.js
  - poc/workers/shared/storage/keys.js
  - poc/workers/shared/pr-context-reader.js
  - poc/workers/zai-heavy-worker/src/handlers/pr-context.js
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
invariant is that **D1 is authoritative** and every other store is either a
blob tier, a transport, or a best-effort derivative.

# Resource roles

| Resource | Binding | Role | Authoritative? |
| --- | --- | --- | --- |
| D1 database | `BOT_DB` (`bot-db`) | Jobs, deliveries, runs, publications, configs — all transactional state | **Yes** |
| R2 bucket | `BOT_ARTIFACTS` (`bot-storage`) | **PR task context** (changed files, diff, commits, comments) per head — the blob tier | Immutable per head |
| Queue | `BOT_JOBS` (`bot-jobs`) | Async transport for job IDs | No (transport only) |
| KV namespace | `BOT_CACHE` (`bot-cache`) | Read-through cache of hot PR/repo params (repo config, PR "card") | No (best-effort, derivative) |

R2 does **not** store the bot's output (the published comment) — that lives on
GitHub plus its D1 publication record. It stores the task **context** that
heavy work consumes; the preview pipeline touches neither R2 nor KV.

# Two R2 grains

R2 objects split into two grains with different keying and retention:

- **Context** (`v1/prs/{repo}/{pr}/{head}/context/{kind}`) — deterministic from
  the PR identity, reused across commands, retained by an R2 lifecycle rule on
  the `v1/prs/` prefix. **No D1 index table**: the key is computable from a
  `pull_requests` row in both directions, so PR↔R2 linking is trivial.
- **Run-outputs** (`v1/runs/{job}/{run}/{kind}.{ext}`) — keyed by job/run,
  indexed by the `artifacts` table, swept by the D1-backed retention cron.
  Reserved for the LLM `response.json` of future review/impact handlers; the
  anti-write-only rule keeps it empty until a reader ships alongside.

# KV is a read-through cache

KV is **never** the source of truth. It caches small, hot, derivative data and
always falls through to D1 on a miss or outage:

- **Repo config** — `getRepositoryConfig()` reads KV first, then D1 on a miss,
  writing the result back (300s TTL). `saveRepositoryConfig()` deletes the key.
- **PR card** — `prCardKey(repo, pr)` holds the latest gathered PR shape (head,
  title, author, counts, `contextReady`), written by the gather job so command
  handlers read the shape without calling `getPullRequest`.

Every KV access is wrapped in a `try/catch` that swallows errors: a KV outage
**degrades** (D1 / R2 answers) rather than fails.

# Versioned key scheme

All R2 and KV keys are prefixed with the storage schema version (`v1/` for R2,
`v1:` for KV). This allows future schema changes without invalidating in-flight
data; retention targets the `v1/` prefix.

# Relationships

- The [D1 storage schema](/datasets/d1-storage-schema.md) defines the
  authoritative tables.
- The [PR-preview pipeline](/workflows/pr-preview-pipeline.md) writes to D1 and
  GitHub only; the [PR-context gather pipeline](/workflows/pr-context-pipeline.md)
  writes the R2 context + KV card.
- The [transactional outbox](/contracts/transactional-outbox.md) bridges D1
  commits to Queue publishes.
- [R2 retention](/rules/r2-retention.md) covers both R2 grains.
