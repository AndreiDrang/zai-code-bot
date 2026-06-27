# Architecture

## 1. High-Level Overview

This repository is a GitHub Action, not a long-running service (`Observed`: `action.yml` declares `using: "node20"` with `main: "dist/index.js"`). The packaged bundle is executed by the GitHub Actions runner in response to webhook events; there is no standalone server process (`Observed`: `package.json` has no `start` script, only `build` and `test`).

Its purpose, as declared by inputs and command surface, is twofold (`Observed`: `action.yml` inputs, `README.md` "Commands" section):

- Automatic pull-request code review driven by the Z.ai API.
- Collaborator-gated `/zai` PR comment commands (`ask`, `review`, `explain`, `describe`, `impact`, `help`) plus a scheduled-task execution mode.

The overarching paradigm is an **event-driven webhook processor**: GitHub webhook events enter through a single `run()` entrypoint, are classified by event type, and are dispatched into either an auto-review flow or a parse → authorize → handler command pipeline (`Observed`: `src/index.js` functions `run`, `handlePullRequestEvent`, `handleIssueCommentEvent`, `handlePullRequestReviewCommentEvent`, `dispatchCommand`).

Evidence anchors: `action.yml`, `package.json`, `src/index.js`, `src/lib/`, `.github/workflows/ci.yml`, `README.md`.

## 2. System Architecture (Logical)

Three logical layers, with strictly downward dependency direction:

1. **Orchestration layer** — `src/index.js`. Owns the GitHub Actions runtime binding, event-type classification, and the high-level auto-review vs. command pipelines. The only module that reads `github.context` directly and wires handlers to the GitHub event loop.
2. **Services layer** — `src/lib/*.js`. Cross-cutting, command-agnostic infrastructure: command parsing, authorization/fork policy, PR context fetching, comment lifecycle (markers + threading + reactions), API client with retry, logging/error categorization, continuity-state persistence, and prompt token budgeting.
3. **Handler layer** — `src/lib/handlers/*.js`. Per-command logic (prompt construction, API call, response formatting). Registered in `src/lib/handlers/index.js` and selected by `dispatchCommand`.

Dependency direction:

```text
GitHub Actions runtime
        │
        ▼
 src/index.js  (orchestration)
        │
        ▼
 src/lib/*.js  (services)
        │
        ▼
 src/lib/handlers/*.js  (commands)
        │
        ▼
 src/lib/api.js + src/lib/pr-context.js  (external I/O: Z.ai, GitHub)
```

Key boundaries:

- **Generated vs. source boundary.** `dist/index.js` is the only artifact GitHub executes; `src/` is the maintained source. This is enforced by CI (`Observed`: `.github/workflows/ci.yml` `dist-drift` job fails on uncommitted `dist/` changes).
- **Authorization precedes execution.** Command handlers must not run before collaborator/fork authorization. The dedicated gate `enforceCommandAuthorization` sits between parsing and dispatch (`Observed`: `src/index.js`; reinforced by `src/lib/auth.js`, `AGENTS.md` anti-patterns).
- **Handlers do not own GitHub I/O directly.** They receive a shared context structure and call into service modules (`api.js`, `pr-context.js`, `comments.js`) rather than touching Octokit ad hoc (`Inferred` from `buildHandlerContext` in `src/lib/context.js` and handler signatures in `src/lib/handlers/AGENTS.md`).
- **Not a server, not a library.** There is no HTTP listener and no published package entrypoint for programmatic consumption (`Observed`: `package.json` `main` points at `dist/index.js` for the Action runtime only).

## 3. Code Map (Physical)

```text
.
├── action.yml                 # Action manifest: inputs + node20 entrypoint contract
├── src/
│   ├── index.js               # Runtime entrypoint: event routing + pipelines
│   └── lib/
│       ├── commands.js        # `/zai` parser + command allowlist
│       ├── auth.js            # Collaborator + fork authorization policy
│       ├── context.js         # Shared handler context (files, ranges, truncation)
│       ├── pr-context.js      # PR files, file-at-ref, base/head ref resolution
│       ├── changed-files.js   # Paginated changed-files fetch (3000-file API ceiling)
│       ├── comments.js        # Marker upsert, threaded replies, reactions
│       ├── api.js             # Z.ai HTTP client + retry wrapper
│       ├── logging.js         # Categorized safe errors / logger wrappers
│       ├── continuity.js      # Hidden-marker state persistence across turns
│       ├── code-scope.js      # Token/character budgeting for prompts
│       ├── auto-review.js     # Large-PR batching + synthesis
│       ├── events.js          # Event-type detection for routing
│       ├── config/
│       │   └── scheduled-config.js   # Parses `.zai-scheduled.yml` task config
│       └── handlers/          # Per-command modules; see `src/lib/handlers/AGENTS.md`
├── tests/                     # Vitest suite: unit + `tests/integration/` e2e pipelines
├── dist/                      # Generated ncc bundle (CI executes dist/index.js)
└── .github/workflows/
    ├── ci.yml                 # test / build / dist-drift / security-audit gates
    └── code-review.yml        # Consumer usage example (not runtime logic)
```

Omitted as non-architectural: `node_modules/`, coverage output, editor config, lockfiles.

## 4. Life of a Request / Primary Data Flow

The runtime is triggered once per webhook event by the Actions runner (`Observed`: `action.yml` `node20` runtime; `src/index.js` `run()`).

**Command path** (issue comment or review comment):

```text
GitHub webhook event
  → src/index.js: run()
  → handleIssueCommentEvent | handlePullRequestReviewCommentEvent
  → src/lib/commands.js: parseCommand          (extract + validate `/zai` command)
  → src/index.js: enforceCommandAuthorization  (collaborator + fork gate via src/lib/auth.js)
  → src/index.js: dispatchCommand (switch on command)
  → src/lib/handlers/<cmd>.js                  (prompt build, context via src/lib/context.js + pr-context.js)
  → src/lib/api.js: callWithRetry → Z.ai       (external LLM call)
  → src/lib/comments.js: upsertComment         (marker-idempotent, threaded reply, reaction)
```

The handler dispatch `switch` over `command` lives in `src/index.js` (`Observed`: `case 'help'`, `'review'`, `'explain'`, `'describe'`, `'ask'`, `'impact'`, `'update-agents'`).

**Auto-review path** (pull_request events):

```text
GitHub pull_request event
  → handlePullRequestEvent
  → src/lib/changed-files.js: fetchAllChangedFiles   (pagination, 3000-file ceiling)
  → src/lib/auto-review.js: createReviewBatches       (large-PR chunking, token budgeting)
  → executeReviewBatch → src/lib/api.js → Z.ai
  → src/lib/comments.js: upsertComment                (marker create/update)
```

**Scheduled-task path**: enabled by the `ZAI_SCHEDULED_*` inputs (`Observed`: `action.yml`); configuration is loaded by `src/lib/config/scheduled-config.js` and executed by `src/lib/handlers/scheduled.js`. The precise scheduling trigger source is `Inferred` to be the Action's scheduled workflow invocation from `README.md`/`action.yml`, not a self-contained scheduler.

## 5. Architectural Invariants & Constraints

- **Rule:** The GitHub runtime executes `dist/index.js` only; all maintained logic lives in `src/`.
  - **Rationale:** Single deployable artifact, auditable source-of-truth.
  - **Enforcement / Signals (Observed):** `action.yml` `main: "dist/index.js"`; `.github/workflows/ci.yml` `dist-drift` job fails on uncommitted `dist/` changes.

- **Rule:** Source changes must be rebuilt (`npm run build`) and `dist/index.js` + `dist/licenses.txt` committed together.
  - **Rationale:** CI executes the bundle, not the source tree.
  - **Enforcement / Signals (Observed):** `package.json` `build` script; `ci.yml` dist-drift gate.

- **Rule:** Command handlers run only after `enforceCommandAuthorization` succeeds (collaborator status + fork policy).
  - **Rationale:** Prevents unauthorized or fork-secret-leaking execution.
  - **Enforcement / Signals (Observed):** dedicated function in `src/index.js`; `src/lib/auth.js`; `AGENTS.md` anti-patterns.

- **Rule:** Command execution is scoped to PR contexts — issue comments on non-PR issues must not dispatch handlers.
  - **Rationale:** Commands are PR-contextual (`review`, `explain`, etc.).
  - **Enforcement / Signals (Observed):** `handleIssueCommentEvent` uses `issue?.number` and PR presence checks.

- **Rule:** Handlers must not pass unbounded diffs/patches into prompts; sizing is bounded via `src/lib/code-scope.js` and `src/lib/context.js`.
  - **Rationale:** Deterministic token budgets and prompt safety.
  - **Enforcement / Signals (Observed + Inferred):** `code-scope.js`, `auto-review.js` batching; `AGENTS.md` anti-patterns.

- **Rule:** Automated comments are idempotent and threaded via marker constants and `replyToId`.
  - **Rationale:** Avoids duplicate spam; ties responses to the invoking comment.
  - **Enforcement / Signals (Observed):** `src/lib/comments.js` `upsertComment`; marker assertions in `tests/integration/`.

- **Rule:** No raw exception internals or secrets are surfaced in PR comments.
  - **Rationale:** User-safe failure reporting.
  - **Enforcement / Signals (Observed + Inferred):** `src/lib/logging.js` categorized safe errors; handler conventions in `AGENTS.md`.

- **Rule:** The services layer (`src/lib/*.js`) stays policy-centric; orchestration stays in `src/index.js`; command-specific logic stays in `src/lib/handlers/`.
  - **Rationale:** Layered separation of concerns.
  - **Enforcement / Signals (Observed + Inferred):** layout convention documented in `src/lib/AGENTS.md`; not machine-enforced.

- **Rule:** External I/O (Z.ai, GitHub) is funneled through `src/lib/api.js` and `src/lib/pr-context.js` rather than ad-hoc calls in handlers.
  - **Rationale:** Centralized retry, size limits, and user-safe fallbacks.
  - **Enforcement / Signals (Inferred):** handler signatures and shared-context pattern; documented in `src/lib/handlers/AGENTS.md`.

## 6. Documentation Strategy

`ARCHITECTURE.md` (this file) is the global map and invariant catalog: it describes layers, dependency direction, entrypoints, and hard rules that span the whole repository.

Local, subtree-specific detail lives in the existing `AGENTS.md` tree:

- `AGENTS.md` — repository overview, code map, build/test commands, gotchas.
- `src/lib/AGENTS.md` — services-layer module guide.
- `src/lib/handlers/AGENTS.md` — per-command handler guide.
- `tests/AGENTS.md` — test strategy and suite layout.
- `tests/integration/AGENTS.md` — end-to-end pipeline test guide.

Global architecture concerns (boundaries, data flow, invariants) belong here. Local concerns (which function implements which command, which test covers which scenario, local conventions) belong in the corresponding `AGENTS.md`. `README.md` documents user-facing inputs, commands, and consumer usage; `.github/workflows/code-review.yml` is a consumer example, not runtime logic.
