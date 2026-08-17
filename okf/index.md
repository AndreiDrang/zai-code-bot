---
okf_version: "0.1"
---

# Knowledge Bundle

OKF knowledge bundle for the **Z.ai Code Bot Cloudflare Workers POC** (`poc/`).
Documents the durable review/describe architecture: a two-worker split with
D1 as the source of truth, a V2 per-PR context snapshot tier in R2 (with
per-file patches and a derived structured PR summary), an agent-mode review
that reads context through LLM tools, a Queue for async processing, and KV
as a read-through cache.

- [Architecture](architecture/) — Foundational design decisions: the worker split and the storage authority model.
- [Workflows](workflows/) — End-to-end flows: webhook ingress, command routing, PR-context gathering, PR-summary generation, LLM command execution, and the cron self-healing sweep.
- [State](state/) — Stateful entities: job lifecycle with bounded leases and the one-live-comment publication.
- [Rules](rules/) — Operational policies: the retry budget, R2 retention, collaborator authorization, and the unified comment footer.
- [Contracts](contracts/) — Stable data contracts: the queue message format, the transactional outbox, the agent context tools, and the agent tool-calling loop.
- [Datasets](datasets/) — Data assets: the D1 storage schema.
