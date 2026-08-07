# Knowledge Bundle Update Log

## 2026-08-07

- **Create**: Added [Unified bot comment footer](/rules/comment-footer.md) — the shared `BOT_FOOTER` now terminates every bot comment.
- **Update**: Reworked [Durable PR-preview pipeline](/workflows/pr-preview-pipeline.md) — the preview is metadata-only; dropped per-file stats fetching and the `files` manifest artifact (the head-sha supersede check is now the only GitHub fetch).
- **Update**: Refreshed [One-live-comment publication](/state/comment-publication.md), [Queue message format](/contracts/queue-message.md), [30-day R2 retention](/rules/r2-retention.md), and [Storage authority model](/architecture/storage-authority-model.md) to drop file-manifest references and reflect the metadata-only brief.
- **Creation**: Initialized the OKF bundle documenting the `poc/` Cloudflare Workers business logic. Created 14 concepts across six semantic directories:
  - `architecture/`: [Two-worker split](/architecture/two-worker-split.md), [Storage authority model](/architecture/storage-authority-model.md).
  - `workflows/`: [Webhook ingress](/workflows/webhook-ingress.md), [Command routing](/workflows/command-routing.md), [Durable PR-preview pipeline](/workflows/pr-preview-pipeline.md), [Cron self-healing sweep](/workflows/cron-self-healing.md).
  - `state/`: [Job lifecycle and bounded leases](/state/job-lifecycle.md), [One-live-comment publication](/state/comment-publication.md).
  - `rules/`: [Three-attempt retry budget](/rules/retry-budget.md), [30-day R2 retention](/rules/r2-retention.md), [Collaborator authorization](/rules/authorization.md).
  - `contracts/`: [Queue message format](/contracts/queue-message.md), [Transactional outbox](/contracts/transactional-outbox.md).
  - `datasets/`: [D1 storage schema](/datasets/d1-storage-schema.md).
- **Note**: Bundle written at repository root (`okf/`) per explicit request, though evidence scope is `poc/`. Source paths are repo-root-relative.
