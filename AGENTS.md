# AGENTS.md

## Scope

Repository-wide guidance for the Cloudflare Workers implementation.

## Repository overview

This project has two Workers under `poc/workers/`:

1. `zai-main-worker` — signed GitHub webhook ingress, authorization, context
   gather scheduling, durable job creation, and recovery cron.
2. `zai-heavy-worker` — private Queue consumer for `review`, `describe`, and
   the internal `pr_context` gather job.

The old GitHub Action runtime (`action.yml`, `src/`, `dist/`, and its tests) has
been removed. Do not recreate it.

## Supported product surface

- `/zai help`
- `/zai review`
- `/zai describe`

`/zai help` is handled inline by the main Worker. Review and describe run through
the durable Queue; there is no legacy service binding.

## Important files

| Area | Location |
|---|---|
| Webhook routing | `poc/workers/zai-main-worker/src/index.js` |
| Command allowlist | `poc/workers/shared/constants.js` |
| Command parsing | `poc/workers/shared/commands.js` |
| Review | `poc/workers/zai-heavy-worker/src/handlers/review.js` |
| Describe | `poc/workers/zai-heavy-worker/src/handlers/describe.js` |
| Queue lifecycle | `poc/workers/zai-heavy-worker/src/queue.js` |
| GitHub API | `poc/workers/shared/github.js` |
| Job/publication storage | `poc/workers/shared/storage/` |
| Worker configuration | `poc/workers/*/wrangler.toml` |

## Invariants

- Verify webhook signatures before parsing or dispatching.
- Authorize commenters before creating command jobs.
- Queue messages contain only `{ schemaVersion, jobId }`.
- D1 is authoritative for job state and comment publication leases.
- Keep comments marker-idempotent and preserve the `describe` body markers.
- Bound all context sent to Z.ai.
- Never expose secrets or raw provider errors in GitHub comments.
- Use Cloudflare bindings and Secrets Store; do not add a GitHub Action
  runtime, `dist` bundle, or public heavy-worker endpoint.

## Validation

```bash
cd poc
npm ci
npm test
npm run deploy:main:dry-run
npm run deploy:heavy:dry-run
```
