# AGENTS.md

## Repository overview

Z.ai Code Bot: Cloudflare Workers that turn `/zai` GitHub PR comments into
Z.ai-powered review and describe results.

- `zai-main-worker` — signed GitHub webhook ingress, authorization, durable job
  creation, PR-context scheduling, and a recovery cron (`*/10 * * * *`).
- `zai-heavy-worker` — private Queue consumer for `review`, `describe`, and the
  internal `pr_context` / `pr_summary` gather jobs.

All implementation and tests live under `src/`; the repository root holds the
npm project (package.json, vitest, prettier, Makefile, CI). Everything else at
the root is docs or tooling:

```text
src/                  # Workers implementation (see src/AGENTS.md)
okf/                  # OKF knowledge bundle; okf/index.md is the entry point
.agents/skills/       # Vendored Cloudflare skills (wrangler, workers-best-practices, …)
*.md                  # ARCHITECTURE, RUNBOOK, SECURITY, CONTRIBUTING, README
```

The old GitHub Action runtime (`action.yml`, its `src/`, and `dist` bundle) has
been removed. Do not recreate it.

## Supported product surface

- `/zai help` — handled inline by the main Worker; no D1 job, no Queue message.
- `/zai review`, `/zai describe` — durable jobs through the `bot-jobs` Queue.

## Important files

| Area                    | Location                                        |
| ----------------------- | ----------------------------------------------- |
| Webhook routing         | `src/zai-main-worker/src/index.js`              |
| Command allowlist       | `src/shared/constants.js`                       |
| Command parsing         | `src/shared/commands.js`                        |
| Review                  | `src/zai-heavy-worker/src/handlers/review.js`   |
| Describe                | `src/zai-heavy-worker/src/handlers/describe.js` |
| Queue lifecycle         | `src/zai-heavy-worker/src/queue.js`             |
| GitHub API              | `src/shared/github.js`                          |
| Job/publication storage | `src/shared/storage/`                           |
| Worker configuration    | `src/*/wrangler.toml`                           |

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

## Context routing

Read only when relevant:

- Cross-worker data flow or boundary changes → `ARCHITECTURE.md`
- Command flow, bindings, R2 context layout → `README.md`
- Operational failures and recovery → `RUNBOOK.md`
- Trust boundaries and user-visible output rules → `SECURITY.md`
- Change rules and commit expectations → `CONTRIBUTING.md`
- Planned features and pending decisions → `ROADMAP.md`
- Workspace mechanics, tests, coverage → `src/AGENTS.md`
- Cloudflare platform questions → `.agents/skills/wrangler/SKILL.md`,
  `.agents/skills/workers-best-practices/SKILL.md`
- `okf/` is a curated knowledge artifact, not source code — start from
  `okf/index.md` and update it deliberately when architecture changes.

## Validation

CI (`.github/workflows/ci.yml`) runs on Node 20 and 22:

```bash
npm ci
npm test
npm run deploy:main:dry-run
npm run deploy:heavy:dry-run
```

CI additionally runs `npm audit --audit-level=moderate`. A root `Makefile`
wraps the same flows: `make test` also prints coverage-column averages via
`scripts/coverage-averages.js`; `make deploy` publishes heavy first, then
main. Workspace mechanics (script inventory, tests, coverage) are in
`src/AGENTS.md`.

<!-- okf-knowledge:start -->

## Open Knowledge Format (OKF)

- OKF knowledge bundles live in an `okf/` directory under their documentation scope.
- Before changing a documented domain, read the nearest `okf/index.md` and the relevant concept documents.
- Update OKF when business rules, workflows, APIs, schemas, data contracts, architecture boundaries, operational playbooks, or canonical references materially change.
- Preserve stable Concept IDs. When moving a concept, update incoming links, directory indexes, and `okf/log.md`.
- After changes, validate frontmatter, internal links, indexes, duplicate resources, stale source paths, and lifecycle status.
- Use the `okf-knowledge` skill to initialize, refresh, reconcile, or audit a bundle.

<!-- okf-knowledge:end -->
