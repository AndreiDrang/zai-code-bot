---
okf_version: "0.1"
---

# Knowledge Bundle

OKF knowledge bundle for the **Z.ai Code Bot Cloudflare Workers POC** (`poc/`).
Documents the durable PR-preview storage architecture: a two-worker split with
D1 as the source of truth, R2 for immutable artifacts, a Queue for async
processing, and KV as a non-authoritative cache.

- [Architecture](architecture/) — Foundational design decisions: the worker split and the storage authority model.
- [Workflows](workflows/) — End-to-end flows: webhook ingress, command routing, the durable PR-preview pipeline, and the cron self-healing sweep.
- [State](state/) — Stateful entities: job lifecycle with bounded leases and the one-live-comment publication.
- [Rules](rules/) — Operational policies: the retry budget, R2 retention, and collaborator authorization.
- [Contracts](contracts/) — Stable data contracts: the queue message format and the transactional outbox.
- [Datasets](datasets/) — Data assets: the D1 storage schema.
