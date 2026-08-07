# Architecture

Foundational design decisions for the POC workers.

- [Two-worker split](two-worker-split.md) — Main acknowledges webhooks instantly; heavy runs async work on its own lifetime budget.
- [Storage authority model](storage-authority-model.md) — D1 is the source of truth; R2, Queue, and KV are immutable, transport, and best-effort respectively.
