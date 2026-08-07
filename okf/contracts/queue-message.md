---
type: Contract
title: Queue message format
description: Queue messages carry only a schema version and job ID — all large data stays in D1 and R2, never in the message body.
source_paths:
  - poc/workers/shared/storage/jobs.js
  - poc/workers/shared/storage/keys.js
  - poc/workers/zai-heavy-worker/src/queue.js
confidence: observed
status: current
tags:
  - contracts
  - queue
---

# Queue message format

The Cloudflare Queue (`bot-jobs`) is a **transport only**, not a data store.
Messages are intentionally minimal so they stay within Cloudflare's message
size limits and survive retries without carrying stale payloads.

# Message shape

```json
{
  "schemaVersion": 1,
  "jobId": "<uuid>"
}
```

The heavy worker's `processQueueMessage()` rejects any message where `jobId`
is missing or `schemaVersion !== 1` by acking it immediately (poison-message
protection).

# Why job-ID-only

- **Size safety**: the Queue has a per-message size ceiling; a full PR manifest
  or rendered markdown would risk rejection.
- **Freshness**: the heavy worker re-reads the job row from D1 on consumption,
  so it always sees the latest state rather than a stale snapshot embedded in
  the message.
- **Idempotency**: duplicate deliveries of the same `{ jobId }` are safe because
  `claimJob()` is atomic — only one consumer wins the lease.
- **Large data location**: manifests and results live in R2 as immutable
  artifacts referenced by the [storage authority model](/architecture/storage-authority-model.md).

# Versioning

`schemaVersion` allows future message format changes without breaking in-flight
consumers. The current version is `1` (`STORAGE_SCHEMA_VERSION`).

# Relationships

- Produced by the [transactional outbox](/contracts/transactional-outbox.md)
  after the D1 commit.
- Consumed by the [PR-preview pipeline](/workflows/pr-preview-pipeline.md).
- The job it references follows the [job lifecycle](/state/job-lifecycle.md).
