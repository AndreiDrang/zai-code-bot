# Workflows

End-to-end flows across the two workers.

- [Webhook ingress](webhook-ingress.md) — The main worker `fetch()` gate chain: method, content-type, signature, parse, dispatch.
- [Command routing](command-routing.md) — `classifyCommand()` splits `/zai` commands into light (inline) or heavy (async) by LLM cost.
- [Durable PR-preview pipeline](pr-preview-pipeline.md) — PR event → D1 job → queue → heavy worker → R2 artifacts → one-live comment.
- [Cron self-healing sweep](cron-self-healing.md) — Every 5 minutes: expired-lease reclaim, outbox replay, R2 retention sweep.
