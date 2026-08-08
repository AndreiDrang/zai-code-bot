# Workflows

End-to-end flows across the two workers.

- [Webhook ingress](webhook-ingress.md) — The main worker `fetch()` gate chain: method, content-type, signature, parse, dispatch.
- [Command routing](command-routing.md) — `classifyCommand()` splits `/zai` commands into light (inline) or heavy (async) by LLM cost.
- [Durable PR-preview pipeline](pr-preview-pipeline.md) — PR event → D1 job → queue → heavy worker → metadata-only one-live comment (no R2/KV).
- [PR-context gather pipeline](pr-context-pipeline.md) — The PR-context writer side: a full eager gather (on new head) + incremental slice refreshes (comments/description on edit events) into per-PR R2 keys + a KV pr-card; consumed by review/impact/ask/explain.
- [Cron self-healing sweep](cron-self-healing.md) — Every 5 minutes: expired-lease reclaim, outbox replay, R2 retention sweep.
