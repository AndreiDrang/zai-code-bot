# Architecture

Foundational design decisions for the Workers implementation.

- [Two-worker split](two-worker-split.md) — Main acknowledges webhooks instantly; heavy runs async work on its own lifetime budget.
- [Storage authority model](storage-authority-model.md) — D1 is the source of truth; R2 is the V2 PR-context blob tier; KV is a read-through cache; the Queue is transport.
