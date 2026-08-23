# Architecture

## 1. High-Level Overview

A GitHub bot that turns `/zai` PR comments and PR events into Z.ai-powered
review and describe results, implemented entirely as Cloudflare Workers: two
deployable Workers (`src/zai-main-worker/`, `src/zai-heavy-worker/`) plus a
shared library tree (`src/shared/`). There is no GitHub Action runtime; the
repository root holds the npm project (tests, tooling, CI, `Makefile`) and
`src/` holds all deployed code.

The paradigm is asynchronous, durable job processing. The public main Worker
validates and schedules; a private heavy Worker consumes the `bot-jobs` Queue
and performs all LLM work. D1 is authoritative for job state and comment
publication leases; R2 stores bounded PR context and command results; KV is a
read-through cache for repository configuration and PR "card" snapshots
(`src/shared/storage/keys.js`). The two Workers never call each other directly
— no service bindings, no cross-worker imports (verified: zero references in
either `src/` tree) — they coordinate only through Queue messages and the
shared D1/R2/KV bindings declared in both `src/zai-*/wrangler.toml` files.

Public ingress is a custom-domain route on the main Worker
(`zai-worker.tokenbel.info`, per `src/zai-main-worker/wrangler.toml`); the
heavy Worker has no HTTP surface at all (`workers_dev = false`, queue consumer
only — see `src/zai-heavy-worker/src/index.js`).

Unknowns: none material.

## 2. System Architecture (Logical)

```text
GitHub webhooks ─▶ zai-main-worker ─{schemaVersion, jobId}─▶ bot-jobs Queue ─▶ zai-heavy-worker ─▶ Z.ai API
                  (fetch + cron)                                  (private consumer)     │
                       │                                                                 ▼
                       │           pr_summary follow-up re-enqueued onto the same Queue
                       ▼                                                                 ▼
                  src/shared/  ◀── imported by both ──▶ GitHub API (result comments)
                       │
                       ▼
     D1 (BOT_DB) · R2 (BOT_ARTIFACTS) · KV (BOT_CACHE) · shared Secrets Store
```

### Main Worker — ingress and scheduling

- Responsibility: public webhook ingress; validation gates (method,
  content-type, HMAC signature, command parse, collaborator authorization);
  inline `/zai help`; durable job creation; PR-event planning; bounded cron
  recovery.
- Code locations: `src/zai-main-worker/src/`
- Entry points: `src/zai-main-worker/src/index.js` — `fetch` (custom-domain
  route) and `scheduled` (cron `*/5 * * * *` per `wrangler.toml` `[triggers]`).
- Depends on: `src/shared/`; D1, R2, KV, Queue producer `BOT_JOBS`, Secrets
  Store.
- Must not depend on: heavy-Worker code (zero cross-worker imports); LLM
  calls — webhooks time out in ~10s, so command work is always offloaded.
- Owns: D1 schema (`src/zai-main-worker/migrations/`); command classification
  (`src/router.js`); PR- and comment-event planning (`src/pr-events.js`,
  `src/comment-events.js`); enqueue, outbox, and recovery
  (`src/job-enqueuer.js`).
- State and external boundaries: writes D1 job + outbox rows; publishes Queue
  messages; best-effort R2 slice refreshes via `ctx.waitUntil`.
- Evidence: `src/zai-main-worker/src/index.js`, `src/zai-main-worker/wrangler.toml`.

### Heavy Worker — queue consumption and LLM processing

- Responsibility: consume `bot-jobs`, claim D1 leases, run `review`,
  `describe`, and the internal `pr_context` / `pr_summary` gather jobs.
- Code locations: `src/zai-heavy-worker/src/`
- Entry points: `src/zai-heavy-worker/src/index.js` — `queue` handler only,
  delegating to `src/queue.js`.
- Depends on: `src/shared/` (Z.ai client, agent runner, context, storage); D1,
  R2, KV, Secrets Store; Z.ai API; GitHub API for publishing; the Queue (also a
  producer — it enqueues the `pr_summary` follow-up itself).
- Must not depend on: main-Worker code; any public HTTP ingress
  (`workers_dev = false` — reached only via the Queue consumer).
- Owns: handler pipeline `src/handlers/` (`review.js`, `describe.js`,
  `pr-context.js`, `pr-summary.js`); prompt sources `prompts/*.txt` compiled to
  committed `generated/prompts.js` by
  `src/zai-heavy-worker/scripts/generate-prompts.mjs`.
- State and external boundaries: claims the D1 lease before executing; records
  runs and artifacts; upserts marker-idempotent comments or the bot-owned PR
  body section; stores the latest command result in R2.
- Evidence: `src/zai-heavy-worker/src/queue.js`,
  `src/zai-heavy-worker/src/handlers/index.js`,
  `src/zai-heavy-worker/wrangler.toml`.

### Shared libraries — `src/shared/`

- Responsibility: GitHub and Z.ai clients; authorization; command
  parsing/allowlist; marker-idempotent comments; bounded PR-context gathering;
  bounded LLM tool-loop execution; system-prompt composition; storage over
  D1/R2/KV; logging; secret resolution.
- Code locations: `src/shared/` (subpackages `agent/`, `context/`,
  `context-tools/`, `prompts/`, `storage/`).
- Depends on: Workers runtime APIs only (Web Crypto, `fetch`, `Response`).
- Must not depend on: either Worker's `src/` (no upward imports; import scan
  confirms); Node-only APIs (per `src/AGENTS.md`, enforced by the Workers
  runtime — no `node:` imports present).
- Owns: R2 key layout and job-kind enumeration (`storage/keys.js`); job/lease/
  outbox SQL (`storage/jobs.js`, `storage/deliveries.js`); the agent loop with
  iteration, tool-call, and duration limits (`agent/runner.js`,
  `agent/limits.js`); Z.ai error sanitization (`zai-client.js`).
- Evidence: import scan across `src/`; `src/AGENTS.md`.

### Durable state and coordination plane

- Responsibility: the only medium through which the two Workers interact.
- Code locations: bindings in both `src/zai-*/wrangler.toml`; access code in
  `src/shared/storage/`.
- Owns: D1 `bot-db` — job/outbox/run/artifact tables (current generation
  `*_v3` in `migrations/0003_pr_summary_job.sql`, with job-kind and status
  CHECK constraints), plus `repositories`, `pull_requests`,
  `webhook_deliveries`, `comment_publications`, and `repository_configs` from
  `migrations/0001_storage_foundation.sql`; R2 `bot-storage` (`v2/prs/`
  context tier under a bucket lifecycle rule applied out-of-band per the
  `wrangler.toml` comments; `v1/runs/` outputs indexed by the `artifacts`
  table and swept by cron); KV `bot-cache`; `bot-jobs` Queue; one shared
  Secrets Store (same store id in both manifests).
- Evidence: both `wrangler.toml` files, `src/zai-main-worker/migrations/`.

### Workspace, tests, and CI

- Responsibility: single script source at the root `package.json`
  (per-Worker manifests serve Wrangler only; wrangler itself is a root
  devDependency); vitest suites in the plain node environment (bindings
  mocked); deploy dry-run and audit gates; prompt codegen.
- Code locations: `vitest.config.js` (root), `src/tests/`,
  `.github/workflows/ci.yml`, `Makefile`.
- Entry points: `npm test`; `npm run deploy:*:dry-run`; `make deploy`
  (publishes heavy first, then main).
- Owns: coverage thresholds gating only `src/shared/**` (95% lines/functions/
  statements, 93% branches) and `src/zai-main-worker/src/**` (90%) — heavy
  Worker handlers are exercised via mocked integration tests, not coverage.
- Evidence: `vitest.config.js`, `.github/workflows/ci.yml`, `Makefile`,
  `src/AGENTS.md`.

## 3. Code Map (Physical)

```text
src/                          # all deployed code; npm project lives at the repo root
├─ zai-main-worker/           # public webhook ingress + cron recovery (src/index.js)
│  └─ migrations/             # D1 schema: storage foundation → command surface → v3 jobs
├─ zai-heavy-worker/          # private Queue consumer (src/index.js → src/queue.js)
│  ├─ src/handlers/           # review, describe, pr-context, pr-summary
│  ├─ prompts/ + generated/   # prompt sources (.txt) → committed modules
│  └─ scripts/                # generate-prompts.mjs (runs via npm generate:prompts)
├─ shared/                    # libraries imported by both Workers (never by Node)
│  ├─ storage/                # D1/R2/KV access + R2 key layout
│  ├─ context/                # PR-context service and size limits
│  ├─ context-tools/          # LLM tool registry and JSON schemas
│  ├─ agent/                  # bounded LLM tool-loop runner and limits
│  └─ prompts/                # system-prompt composition and context policies
└─ tests/                     # vitest suites (node env, mocked bindings)
okf/                          # curated knowledge bundle (entry: okf/index.md)
.agents/skills/               # vendored Cloudflare skills (reference only)
.github/workflows/ci.yml      # test + coverage, dry-run deploys, npm audit
Makefile                      # root flow wrappers (test, deploy: heavy then main)
scripts/coverage-averages.js  # coverage-column reporting for make test
```

## 4. Life of a Request / Primary Data Flow

### `/zai review` / `/zai describe` command (sync ingress → async processing)

1. Trigger: GitHub comment webhook carrying a `/zai` command body.
2. Entry point: `src/zai-main-worker/src/index.js` `fetch`.
3. Coordination: gate chain (method → content-type → HMAC → parse →
   collaborator authorization); classification in `src/router.js`; durable job
   row via `src/shared/storage/deliveries.js`.
4. Core or domain processing: main Worker publishes `{ schemaVersion, jobId }`
   to `bot-jobs` (D1 outbox row is the recovery fallback), returns 202; heavy
   Worker `src/queue.js` claims the D1 lease and dispatches to
   `src/handlers/review.js` / `describe.js`;
   `src/shared/llm-command-runner.js` drives the bounded agent loop
   (`src/shared/agent/runner.js`) over `src/shared/zai-client.js`, fetching
   diffs and source files lazily via Context Tools.
5. Persistence or external interaction: run and result recorded in D1
   (`analysis_runs`, `artifacts`) and R2; comment upsert guarded by the
   `comment_publications` lease.
6. Output or side effect: marker-idempotent review comment or bot-owned PR
   body section; job marked succeeded/failed/retryable in D1.

Architectural boundaries crossed: public HTTP → main Worker; Queue → private
heavy Worker; shared code → D1/R2/KV/GitHub/Z.ai.
Evidence: `src/zai-main-worker/src/index.js`, `src/zai-heavy-worker/src/queue.js`,
sequence diagram in `README.md`.

### PR context gathering and summary chain (event-driven)

1. Trigger: PR `opened` / `reopened` / `synchronize` / `ready_for_review`
   (plus description-edit and comment-refresh planning in
   `src/pr-events.js`, `src/comment-events.js`).
2. Entry point: main Worker `fetch` → planning in `src/pr-events.js`.
3. Coordination: `pr_context` job created and enqueued like a command job.
4. Core or domain processing: `src/handlers/pr-context.js` gathers V2 context
   to R2 `v2/prs/{repositoryId}/{prNumber}/context/` (manifest, files,
   commits, description, comments, per-file patches); once the manifest
   commits, an idempotent `pr_summary` job is enqueued (outbox fallback) and
   `src/handlers/pr-summary.js` stores the validated Z.ai JSON summary there.
5. Persistence or external interaction: R2 context tier plus D1 job rows.
6. Output or side effect: later `review` commands reuse the matching-head
   summary as auxiliary context.

Architectural boundaries crossed: GitHub → main Worker → Queue → heavy Worker
→ GitHub API, R2, Z.ai. Evidence: `src/zai-main-worker/src/pr-events.js`,
`src/zai-heavy-worker/src/handlers/pr-context.js` and `pr-summary.js`.

### Cron recovery sweep (scheduled)

1. Trigger: cron `*/5 * * * *` on the main Worker.
2. Entry point: `scheduled` handler in `src/zai-main-worker/src/index.js`.
3. Coordination: bounded batches in `src/job-enqueuer.js`.
4. Core or domain processing: recover expired job leases, replay due outbox
   rows, sweep expired storage via `deleteExpiredArtifacts`
   (`v1/runs/` objects indexed by the `artifacts` table).
5. Persistence or external interaction: D1 lease/outbox/artifact rows; R2
   deletions only.
6. Output or side effect: stranded jobs become retriable; orphaned R2 objects
   removed.

Boundaries crossed: scheduler → main Worker → D1/R2 only (no GitHub/Z.ai).
Evidence: `src/zai-main-worker/src/job-enqueuer.js`,
`src/shared/storage/artifacts.js`, `RUNBOOK.md`.

## 5. Architectural Invariants & Constraints

- Rule: Verify the webhook HMAC signature before parsing or dispatching.
- Rationale: the fetch handler is the only public, unauthenticated surface.
- Enforcement / Signals: gate ordering in `src/zai-main-worker/src/index.js`;
  `src/tests/crypto.test.js`, `src/tests/router.test.js`.

- Rule: Queue messages carry only `{ schemaVersion, jobId }` — no tokens or
  source data.
- Rationale: keeps secrets and content out of the transport; D1 stays the
  single source of truth.
- Enforcement / Signals: producer in `src/shared/storage/deliveries.js`;
  consumer validates `schemaVersion === 1` in `src/zai-heavy-worker/src/queue.js`.

- Rule: D1 is authoritative for job state and comment publication leases; a
  lease must be claimed before a handler runs.
- Rationale: at-least-once delivery plus cron recovery need one durable
  arbiter; duplicate deliveries must be idempotent.
- Enforcement / Signals: `claimJob` in `src/shared/storage/jobs.js`; lease
  tables in `src/zai-main-worker/migrations/` (current generation `*_v3`).

- Rule: the two Workers are isolated deployment units — no cross-worker
  imports, no service bindings, no public HTTP endpoint on the heavy Worker.
- Rationale: keeps ingress and processing independently deployable and keeps
  LLM work and GitHub writes reachable only through the Queue.
- Enforcement / Signals: zero cross-worker imports (verified by scan; a
  structural convention, not linted); no `services` entries and
  `workers_dev = false` in `src/zai-heavy-worker/wrangler.toml`; queue-only
  export in `src/zai-heavy-worker/src/index.js`.

- Rule: `src/shared/` runs on Workers runtime APIs only — no Node built-ins.
- Rationale: the same code deploys into both Workers; Node APIs fail at
  runtime.
- Enforcement / Signals: `src/AGENTS.md` convention; Workers runtime and both
  dry-run builds in CI.

- Rule: the heavy Worker never calls Z.ai or GitHub from an HTTP request
  path; all such calls run inside claimed Queue jobs.
- Rationale: webhooks time out in ~10s; durable leases make retries safe.
- Enforcement / Signals: main-Worker `fetch` only enqueues; LLM and publish
  calls appear only under `src/zai-heavy-worker/src/queue.js` handlers.

- Rule: GitHub comments are marker-idempotent, `describe` body markers are
  preserved, and secrets or raw provider errors are never surfaced.
- Rationale: repeated deliveries must not duplicate output; comments are
  public-facing.
- Enforcement / Signals: `src/shared/comments.js`;
  `comment_publications` lease; `sanitizeErrorMessage` in
  `src/shared/zai-client.js`; `SECURITY.md`.

- Rule: context sent to Z.ai is bounded, and agent runs are capped by
  iteration, tool-call, and duration limits.
- Rationale: cost and prompt-size control; a runaway tool loop must not burn
  a Worker invocation.
- Enforcement / Signals: limits in `src/shared/context/context-limits.js` and
  `src/shared/agent/limits.js`; `src/tests/context-service.test.js`,
  `src/tests/agent-runner.test.js`.

- Rule: secrets come only from Cloudflare Secrets Store bindings, never from
  `wrangler.toml` values or source.
- Rationale: one shared store keeps a single rotation point for both Workers.
- Enforcement / Signals: `[[secrets_store_secrets]]` in both
  `wrangler.toml` files; `src/shared/secrets.js`; `npm audit` gate in CI.

- Rule: the public command surface and job kinds are fixed — `help` inline;
  `review`, `describe`, `pr_context`, `pr_summary` durable.
- Rationale: the allowlist is a product contract, not a convenience.
- Enforcement / Signals: allowlist in `src/shared/constants.js`; job-kind
  CHECK constraint in
  `src/zai-main-worker/migrations/0003_pr_summary_job.sql`; parsing in
  `src/shared/commands.js`; classification in `src/router.js`.

- Rule: deploy order is heavy Worker first, then main Worker.
- Rationale: the main Worker's Queue producer binding resolves against the
  deployed consumer.
- Enforcement / Signals: `make deploy` target ordering and comment in
  `Makefile`; root `package.json` `build` script (heavy dry-run first).

## 6. Documentation Strategy

`ARCHITECTURE.md` (this file) owns the global architecture map: components,
dependency direction, representative flows, and invariants. It deliberately
does not duplicate operational or local detail:

- `AGENTS.md` (root) — repository-wide agent rules and task-based routing.
- `src/AGENTS.md` — tree mechanics, local boundaries, coverage-gate policy.
- `src/zai-main-worker/AGENTS.md`, `src/zai-heavy-worker/AGENTS.md` —
  per-Worker local instructions (including prompt regeneration).
- `README.md` — bindings, command-flow sequence diagram, R2 `v2/prs/`
  layout, development workflow.
- `RUNBOOK.md` — operational failure modes and cron-based recovery.
- `SECURITY.md` — trust boundaries and user-visible output rules.
- `CONTRIBUTING.md` — change rules and commit expectations.
- `okf/index.md` — curated, navigation-oriented knowledge bundle.

No ADR or `DESIGN.md` exists today; that absence does not limit the
architecture model.
