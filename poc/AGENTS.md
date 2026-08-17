# AGENTS.md

## Scope and inheritance

Applies to: `poc/` and everything under it.

Inherits repository-wide guidance from `../AGENTS.md`. This file defines only
local differences for this workspace.

## What lives here

Single npm workspace for the Cloudflare Workers implementation:

```text
workers/
├── shared/               # Code bundled into BOTH workers — no worker-specific logic
│   ├── storage/          # D1 jobs/leases, R2 artifacts, KV config, key helpers
│   ├── context/          # PR-context gather service + limits
│   └── context-tools/    # Structured tool schemas/registry for Z.ai calls
├── zai-main-worker/      # Webhook ingress, D1 jobs, Queue producer (own AGENTS.md)
├── zai-heavy-worker/     # Queue consumer + LLM handlers (own AGENTS.md)
└── tests/                # Flat *.test.js suite (no __tests__/, no mirroring)
```

## Local boundaries and invariants

- Only `poc/package.json` defines real scripts; per-worker `package.json` files
  exist only for Wrangler (`dev`, `deploy`, `tail`, `generate:prompts`).
- `shared/` runs inside the Workers runtime, not Node — Web Crypto, `fetch`,
  `Response`, `Headers` only. No `node:fs`, `node:path`, or Node-only APIs.
- Changes to `shared/` affect both deployed workers; both dry-runs must pass.
- Tests import modules directly (e.g. `../shared/crypto.js`) and run under
  `vitest` with miniflare (see `vitest.config.js`); `TEST_ENV` can flip to
  `node` if miniflare breaks on the current Node version.
- Coverage thresholds (80% lines/functions/branches/statements) apply only to
  `workers/shared/**` and `zai-main-worker/src/router.js` — handler and
  entrypoint coverage does not gate CI.

## Validation

```bash
npm ci
npm test                      # vitest run --coverage (from poc/)
npm run format:js:check       # prettier check for workers/**/*.js
npm run build                 # both deploy dry-runs in one command
```

Deploy, dev, and dry-run scripts: `deploy:main[:dry-run]`, `deploy:heavy[:dry-run]`,
`dev:main`, `dev:heavy`, `tail:main`, `tail:heavy` — all from `poc/`.

## Nearby docs

- Bindings, command flow, R2 `v2/prs/` layout → `README.md` (this directory)
- Prompt sources and regeneration → `workers/zai-heavy-worker/AGENTS.md`
