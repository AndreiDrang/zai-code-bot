---
type: Contract
title: Transactional outbox
description: The job_outbox table bridges the D1 commit and the Queue publish so a crash between them never loses a job — the cron replays unpublished outbox rows.
source_paths:
  - poc/workers/shared/storage/deliveries.js
  - poc/workers/shared/storage/jobs.js
  - poc/workers/zai-main-worker/src/job-enqueuer.js
  - poc/workers/zai-main-worker/migrations/0001_storage_foundation.sql
confidence: observed
status: current
tags:
  - contracts
  - outbox
  - reliability
---

# Transactional outbox

Publishing to the Cloudflare Queue cannot participate in the D1 transaction
that creates the job. If the worker crashes after the D1 commit but before the
Queue publish, the job would be permanently stranded. The transactional outbox
pattern closes this gap.

# Mechanism

`createPrPreviewJob()` writes three rows in a **single D1 batch**:

1. `webhook_deliveries` — the idempotent delivery record.
2. `jobs` — the durable job in `queued` status.
3. `job_outbox` — the outbox row with `published_at = NULL` and
   `next_attempt_at = now`.

Because all three are in one transaction, either the job exists with a pending
outbox entry, or none of them exist — never a job without an outbox entry.

# Publish and replay

After the commit, `enqueueJob()` attempts the Queue publish immediately. On
success, `markOutboxPublished()` sets `published_at`. On failure, the outbox
row remains pending.

The [cron self-healing sweep](/workflows/cron-self-healing.md) runs
`replayDueOutbox()` every 5 minutes, finding rows where
`published_at IS NULL AND next_attempt_at <= now` and re-attempting the
publish. `recordOutboxFailure()` increments `publish_attempts` and sets a
backoff `next_attempt_at` so a persistently failing publish doesn't hammer the
Queue API.

# Index

`idx_outbox_due ON job_outbox(published_at, next_attempt_at)` supports the
efficient due-row lookup.

# Relationships

- Produces [queue messages](/contracts/queue-message.md).
- Replayed by the [cron self-healing sweep](/workflows/cron-self-healing.md).
- Part of the [storage authority model](/architecture/storage-authority-model.md)
  — D1 is the source of truth, the Queue is transport.
- Schema is defined in the [D1 storage schema](/datasets/d1-storage-schema.md).
