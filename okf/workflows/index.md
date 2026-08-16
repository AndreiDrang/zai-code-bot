# Workflows

End-to-end flows across the two workers.

- [Webhook ingress](webhook-ingress.md) — The main worker `fetch()` gate chain: method, content-type, signature, parse, dispatch.
- [Command routing](command-routing.md) — `classifyCommand()` routes the
  supported `review` and `describe` commands to durable Queue jobs.
- [PR-context gather pipeline](pr-context-pipeline.md) — The context writer
  side: a full eager gather on new heads plus incremental comment/description
  refreshes, consumed by review and describe.
- [Cron self-healing sweep](cron-self-healing.md) — Every 5 minutes: expired-lease reclaim, outbox replay, R2 retention sweep.
