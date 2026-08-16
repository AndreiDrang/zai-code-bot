# Architecture

Z.ai Code Bot runs entirely on Cloudflare Workers. There is no GitHub Action
runtime, bundled `dist/` artifact, or Node entrypoint.

## Runtime

1. `zai-main-worker` receives GitHub webhooks.
2. It verifies the HMAC signature and gates commands through collaborator
   authorization.
3. PR head events enqueue a `pr_context` gather job.
4. `/zai review` and `/zai describe` comments create durable command jobs.
5. `zai-heavy-worker` consumes `{ schemaVersion, jobId }`, claims the D1 lease,
   calls Z.ai, and publishes the result to GitHub.

D1 is authoritative for jobs and comment publication leases. R2 stores bounded
PR context and the latest command result. KV is a read-through cache for small
repository and PR snapshots. Queue messages intentionally contain no tokens or
source data.

## Boundaries

- `poc/workers/zai-main-worker/src/` owns webhook routing and scheduling.
- `poc/workers/zai-heavy-worker/src/handlers/review.js` owns review prompt
  construction.
- `poc/workers/zai-heavy-worker/src/handlers/describe.js` owns PR description
  generation and the bot-owned PR-body section.
- `poc/workers/shared/` owns GitHub/Z.ai clients, auth, context, storage, and
  marker-idempotent comments.

Only `review` and `describe` are public commands. Removed commands must not be
reintroduced without an explicit product decision.

## Validation

Run tests from `poc/`:

```bash
npm ci
npm test
npm run deploy:main:dry-run
npm run deploy:heavy:dry-run
```
