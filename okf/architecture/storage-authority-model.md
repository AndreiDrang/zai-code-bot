---
type: Architecture
title: Storage authority model
description: D1 is the source of truth for all job, delivery, and publication state; R2 holds the V2 PR-context snapshot tier (plus D1-indexed run-outputs); KV is a read-through cache; the Queue is a transport.
source_paths:
  - src/shared/storage/config.js
  - src/shared/storage/database.js
  - src/shared/storage/keys.js
  - src/shared/pr-context-reader.js
  - src/shared/pr-comments.js
  - src/shared/pr-description.js
  - src/shared/context/context-service.js
  - src/zai-heavy-worker/src/handlers/pr-context.js
  - src/zai-main-worker/wrangler.toml
  - src/zai-heavy-worker/wrangler.toml
  - README.md
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
| R2 bucket | `BOT_ARTIFACTS` (`bot-storage`) | **PR-context V2 snapshot tier** + run-outputs — the blob tier | Mutable (latest snapshot; overwritten on new head by the gather, refreshed slice-by-slice on edit events) |
| Queue | `BOT_JOBS` (`bot-jobs`) | Async transport for job IDs | No (transport only) |
| KV namespace | `BOT_CACHE` (`bot-cache`) | Read-through cache of hot PR/repo params (repo config, PR "card") | No (best-effort, derivative) |

R2 does **not** store the bot's output (the published comment) — that lives
on GitHub plus its D1 publication record. It stores the task **context**
that heavy work consumes, the latest command results, and the generated PR
summary.

# Two R2 grains

R2 objects split into two grains with different keying and retention:

- **Context** (`v2/prs/{repo}/{pr}/context/…`) — keyed per PR (NOT per head);
  the latest snapshot is overwritten on each new head, with the head it
  describes stamped inside `manifest.headSha` (the manifest is written last
  and acts as the complete-snapshot commit marker). Contents: the five slice
  kinds (`manifest|files|commits|description|comments`), one patch object
  per changed text file under `diffs/{encoded-path}.patch`
  (`PR_CONTEXT_STORAGE_VERSION = 2`), plus non-`PR_CONTEXT_KINDS` objects
  that ride the same prefix: command results (`{command}.md`, overwrite) and
  `pr-summary.json`. Two writers share these keys: the full
  [gather](/workflows/pr-context-pipeline.md) (every slice, on a new head)
  and the incremental slice refresh (a single slice, on an edit event) —
  safe because each slice has one shared projection. Retained by an R2
  lifecycle rule on the `v2/prs/` prefix. **No D1 index**: the key is
  computable from a `pull_requests` row in both directions.
- **Run-outputs** (`v1/runs/{job}/{run}/{kind}.{ext}`) — keyed by job/run,
  indexed by the `artifacts` table, swept by the D1-backed retention cron
  (`STORAGE_SCHEMA_VERSION = 1`).

All application reads of the context tier go through the
[Context Service](/contracts/agent-context-tools.md) DTO layer — raw storage
shapes never reach prompts or tools.

# KV is a read-through cache

KV is **never** the source of truth. It caches small, hot, derivative data
and always falls through to D1 on a miss or outage:

- **Repo config** — `getRepositoryConfig()` reads KV first, then D1 on a
  miss, writing the result back (300s TTL). `saveRepositoryConfig()` deletes
  the key.
- **PR card** — `prCardKey(repo, pr)` holds the latest gathered PR shape
  (head, title, author, counts, `contextReady`, `contextStorageVersion`),
  written by the gather job so command handlers read the shape without
  calling `getPullRequest`. TTL 30 days, matching the R2 context lifecycle.

Every KV access is wrapped in a `try/catch` that swallows errors: a KV
outage **degrades** (D1 / R2 answers) rather than fails.

# Versioned key scheme

R2 and KV keys are prefixed with their schema version — R2 context keys with
the independent `PR_CONTEXT_STORAGE_VERSION` (`v2/`), everything else with
`STORAGE_SCHEMA_VERSION` (`v1/` R2, `v1:` KV). The context version is
deliberately separate because deliveries, runs, and KV cache keys do not
participate in the context-storage contract; this allows future context
schema changes without invalidating in-flight job state.

# Relationships

- The [D1 storage schema](/datasets/d1-storage-schema.md) defines the
  authoritative tables.
- The [PR-context gather pipeline](/workflows/pr-context-pipeline.md) writes
  the R2 context + KV card; the [PR-summary job](/workflows/pr-summary-job.md)
  writes `pr-summary.json` into the same tier.
- The [transactional outbox](/contracts/transactional-outbox.md) bridges D1
  commits to Queue publishes.
- [R2 retention](/rules/r2-retention.md) covers both R2 grains.
