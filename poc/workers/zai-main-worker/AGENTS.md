# AGENTS.md

## Scope and inheritance

Applies to: `poc/workers/zai-main-worker/` and its descendants.

Inherits repository-wide guidance from `../../../AGENTS.md` and workspace
mechanics from `../../AGENTS.md`. This file defines only local rules for the
public ingress Worker.

## What lives here

```text
src/
├── index.js           # Entrypoint: async fetch + async scheduled (recovery cron)
├── router.js          # Command classification: help | light | heavy | unsupported
├── comment-events.js  # /zai comment webhook handling
├── pr-events.js       # PR opened/reopened/synchronize/ready_for_review → pr_context
└── job-enqueuer.js    # Durable job creation + Queue publish (D1 outbox first)
migrations/            # D1 migrations, applied via migrations_dir in wrangler.toml
wrangler.toml          # Public routes, bindings, Secrets Store, cron trigger
```

## Local boundaries and invariants

- This is the only Worker with public ingress. Any new `fetch` route is a new
  trust-boundary surface: verify the HMAC signature before reading the body,
  and never add an unauthenticated endpoint.
- Route gotchas (see comments in `wrangler.toml`): adding a `[[routes]]` entry
  infers `workers_dev = false` on the next deploy. `zai-worker.tokenbel.info`
  is served by a single `custom_domain` route (Cloudflare auto-creates the DNS
  record + TLS cert). The GitHub webhook targets that hostname — don't break
  it.
- D1 migrations are sequential (`0001_storage_foundation.sql`, …). Never edit
  an applied migration; add the next numbered file. Both workers share the same
  D1 database, so a migration changes the heavy worker's schema too.
- `async scheduled` runs every 5 minutes as the recovery sweep; keep it
  idempotent (it re-drives the D1 outbox, expires stuck leases, re-enqueues
  stranded due jobs, and sweeps expired R2 artifacts).
- Secrets come from the shared Cloudflare Secrets Store bindings declared in
  `wrangler.toml`; no secret values belong in this directory.

## Validation

```bash
npm run deploy:main:dry-run   # from poc/ — must pass before any deploy
```

`workers/shared/` changes additionally require `npm run deploy:heavy:dry-run`.

## Nearby docs

- Runtime diagram and boundaries → `../../../ARCHITECTURE.md`
- Command flow and bindings → `../../README.md`
- Cron sweep failure recovery → `../../../RUNBOOK.md`
