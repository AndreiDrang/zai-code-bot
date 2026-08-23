# AGENTS.md

## Scope and inheritance

Applies to: `src/zai-heavy-worker/` and its descendants.

Inherits repository-wide guidance from `../../AGENTS.md` and tree mechanics
from `../AGENTS.md`. This file defines only local rules for the
private Queue consumer.

## What lives here

```text
src/
├── index.js           # Entrypoint: async queue() only — no fetch handler
├── queue.js           # Batch handling, D1 lease claims, retry/failure policy
└── handlers/          # review.js, describe.js, pr-context.js, pr-summary.js
prompts/               # Human-authored sources: review.txt, pr-summary.txt
generated/             # Committed output of scripts/generate-prompts.mjs
scripts/               # generate-prompts.mjs — turns prompts/*.txt into JS modules
wrangler.toml          # Queue consumer config; workers_dev = false
```

## Local boundaries and invariants

- `generated/prompts.js` is committed build output (so `wrangler deploy` needs
  no prebuild). To change a prompt: edit `prompts/*.txt`, run
  `npm run generate:prompts` from this directory, and commit the regenerated
  file. New prompts also need an entry in `PROMPTS` in the script. Never
  hand-edit anything under `generated/`.
- This Worker must stay private: `workers_dev = false`, no `fetch` handler, no
  routes, no service bindings. It is reached only via the `bot-jobs` Queue.
- Handlers publish through the marker-idempotent helpers in
  `shared/pr-comments.js` / `shared/comments.js`; `describe` owns its
  marker-delimited section of the PR body. Do not publish around the markers.
- PR context lives in R2 under `v2/prs/{repositoryId}/{prNumber}/context/`
  (manifest, per-file patches, `pr-summary.json`). Objects under `v2/prs/`
  expire via a bucket-level lifecycle rule — the rule lives on the bucket, not
  in `wrangler.toml` (the `wrangler r2 bucket lifecycle add` command and the
  `R2_RETENTION_DAYS` var are documented there; keep them aligned when
  changing retention). `v1/runs/` artifacts are swept by the D1 cron instead.
- `pr_summary` stores structured JSON in R2 and never posts a GitHub comment.

## Validation

```bash
npm run deploy:heavy:dry-run   # from the repo root — must pass before any deploy
```

`src/shared/` changes additionally require `npm run deploy:main:dry-run`.

## Nearby docs

- Command flow, queue contract, bindings → `../../README.md`
- Queue delivery failures and recovery → `../../RUNBOOK.md`
