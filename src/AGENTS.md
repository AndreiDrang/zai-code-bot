# AGENTS.md

## Scope and inheritance

Applies to: `src/` and everything under it.

Inherits repository-wide guidance from `../AGENTS.md`. This file defines only
local differences for this tree.

## What lives here

Cloudflare Workers implementation tree (npm scripts live in the root
`package.json`):

```text
src/
├── shared/               # Code bundled into BOTH workers — no worker-specific logic
│   ├── storage/          # D1 jobs/leases, R2 artifacts, KV config, key helpers
│   ├── context/          # PR-context gather service + limits
│   ├── context-tools/    # Structured tool schemas/registry for Z.ai calls
│   ├── agent/            # Bounded LLM tool-loop runner + limits
│   └── prompts/          # System-prompt composition + context policies
├── zai-main-worker/      # Webhook ingress, D1 jobs, Queue producer (own AGENTS.md)
├── zai-heavy-worker/     # Queue consumer + LLM handlers (own AGENTS.md)
└── tests/                # Flat *.test.js suite (no __tests__/, no mirroring)
```

## Local boundaries and invariants

- Only the root `package.json` defines real scripts; per-worker
  `package.json` files exist only for Wrangler (`dev`, `deploy`, `tail`,
  `generate:prompts`).
- `shared/` runs inside the Workers runtime, not Node — Web Crypto, `fetch`,
  `Response`, `Headers` only. No `node:fs`, `node:path`, or Node-only APIs.
- Changes to `shared/` affect both deployed workers; both dry-runs must pass.
- Tests import modules directly (e.g. `../shared/crypto.js`) and run under
  `vitest` with miniflare (see `vitest.config.js`); `TEST_ENV` can flip to
  `node` if miniflare breaks on the current Node version.
- Coverage applies to `src/shared/**` and all of `src/zai-main-worker/src/**`
  (entrypoint included — `index.js` is tested via
  `src/tests/index-fetch.test.js` with mocked bindings; `job-enqueuer.js`
  via `src/tests/job-enqueuer.test.js`). Per-glob thresholds in
  `vitest.config.js` (repo root): shared 95% lines/functions/statements + 93%
  branches; main worker 90% across all metrics.

## Validation

```bash
npm ci                       # from the repo root
npm test                     # vitest run --coverage
npm run format:js:check      # prettier check for src/**/*.js
npm run build                # both deploy dry-runs in one command
```

Deploy, dev, and dry-run scripts: `deploy:main[:dry-run]`, `deploy:heavy[:dry-run]`,
`dev:main`, `dev:heavy`, `tail:main`, `tail:heavy` — all from the repo root.
The `wrangler` binary is expected on PATH (per the Makefile); CI instead
installs per-worker dependencies under each worker's `node_modules` before
the dry-runs.

## Nearby docs

- Bindings, command flow, R2 `v2/prs/` layout → `../README.md` (repo root)
- Prompt sources and regeneration → `zai-heavy-worker/AGENTS.md`
