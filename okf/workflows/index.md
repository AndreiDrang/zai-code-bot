# Workflows

End-to-end flows across the two workers.

- [Webhook ingress](webhook-ingress.md) — The main worker `fetch()` gate chain and its three-way fork: PR-context jobs, incremental slice refreshes, command comments.
- [Command routing](command-routing.md) — `classifyCommand()` routes the supported `review` and `describe` commands to durable Queue jobs.
- [PR-context gather pipeline](pr-context-pipeline.md) — The context writer side: a V2 per-PR snapshot with per-file patches on new heads, stale-head rejection, incremental comment/description refreshes, and pr_summary scheduling.
- [PR-summary job](pr-summary-job.md) — The internal pr_summary job converts a committed snapshot into validated structured JSON used as auxiliary review context.
- [LLM command execution](llm-command-execution.md) — The shared runner for review and describe (agent-mode with Context Tools), with guards, result persistence, and marker-idempotent comments.
- [Cron self-healing sweep](cron-self-healing.md) — Every 5 minutes: expired-lease reclaim, outbox replay, R2 retention sweep.
