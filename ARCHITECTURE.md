# Architecture

## 1. High-Level Overview

**zai-code-bot** is a JavaScript GitHub Action that performs automatic pull-request code review and serves collaborator-gated `/zai` (or `@zai-bot`) comment commands backed by Z.ai chat-completion models (`Observed`: `action.yml`, `src/index.js`, `README.md`). It runs inside GitHub Actions workflows on the Node 20 runtime (`Observed`: `action.yml` — `runs.using: node20`, `main: dist/index.js`) and reacts to three webhook event classes: `pull_request`, `issue_comment`, and `pull_request_review_comment` (`Observed`: `src/lib/events.js`, dispatch in `src/index.js`).

Business purpose (`Observed`): (1) automatic code review when a PR is opened or synchronized, and (2) an interactive assistant exposing six commands — `ask`, `review`, `explain`, `describe`, `impact`, `help` (`Observed`: `src/lib/commands.js` `ALLOWED_COMMANDS`, `README.md` Features).

Paradigm (`Observed`): an event-driven action with a single orchestrator (`src/index.js`) that gates, parses, authorizes, and dispatches GitHub events to a set of command handlers under `src/lib/handlers/`. External dependencies are exactly two API surfaces: the GitHub REST API via `@actions/github` octokit, and the Z.ai chat completions endpoint (`Observed`: `src/lib/api.js`, the `ZAI_API_URL` constant in `src/index.js`).

Evidence anchors: `action.yml`, `package.json`, `src/index.js`, `src/lib/commands.js`, `src/lib/api.js`, `README.md`.

---

## 2. System Architecture (Logical)

Four logical layers, strictly one-directional top-down:

```
GitHub webhook events
        │
        ▼
Event router / orchestrator   ── src/index.js
  (run, handle*Event, dispatchCommand, enforceCommandAuthorization)
        │
        ▼
Cross-cutting services        ── src/lib/*
  events · commands · auth · comments · api · context · pr-context
  changed-files · auto-review · continuity · code-scope · logging
        │
        ▼
Command handlers              ── src/lib/handlers/*
  ask · describe · explain · help · impact · review (+ index.js registry)
        │
        ▼
External services
  GitHub REST (octokit) · Z.ai chat completions (https://api.z.ai/...)
```

Component responsibilities (`Observed`):
- **Orchestrator** (`src/index.js`): the only runtime entrypoint. Detects event type, filters bots, parses commands, enforces authorization, and dispatches to handlers. Owns the large-PR review batching pipeline (`runLargePrReview`, `executeReviewBatch`).
- **Cross-cutting services** (`src/lib/*`): stateless utilities consumed by both the orchestrator and handlers. No service depends on a handler or on the orchestrator.
- **Command handlers** (`src/lib/handlers/*`): one module per command, aggregated by `handlers/index.js`. Each handler builds a prompt, calls Z.ai through `api.js`, and posts results through `comments.js`.
- **External services**: GitHub octokit for PR/file/comment reads and writes; Z.ai for model inference.

**Dependency direction**: `src/index.js` → `src/lib/*` → handlers → external APIs.

**Intentional non-dependencies** (`Observed`): services never depend on handlers; handlers never import sibling handlers (only the `handlers/index.js` registry imports handlers); `dist/` is never required by any source file; test code imports only from `src/`, never from `dist/`.

---

## 3. Code Map (Physical)

```text
zai-code-bot/
├── action.yml                 # Action inputs + Node 20 runtime contract (entry: dist/index.js)
├── package.json               # Deps (@actions/core, @actions/github); scripts build/test
├── src/
│   ├── index.js               # Runtime orchestrator: run(), event handlers, dispatch, auth gate
│   └── lib/
│       ├── events.js          # getEventType / shouldProcessEvent (bot + action filtering)
│       ├── commands.js        # ALLOWED_COMMANDS, parseCommand, isValid
│       ├── auth.js            # Collaborator + fork-aware authorization
│       ├── comments.js        # REACTIONS, upsertComment (marker + replyToId), setReaction
│       ├── api.js             # createApiClient, callWithRetry, error sanitize/categorize
│       ├── context.js         # truncateContext, DEFAULT_MAX_CHARS, buildHandlerContext
│       ├── pr-context.js      # Shared PR fetch: fetchPrFiles, fetchFileAtRef, large-file scoping
│       ├── changed-files.js   # Paginated fetchAllChangedFiles (MAX_PR_FILES_API_LIMIT = 3000)
│       ├── auto-review.js     # createReviewBatches, isLargePr, batch + synthesis prompt builders
│       ├── continuity.js      # Hidden-marker state persistence across comment turns
│       ├── code-scope.js      # Sliding-window + enclosing-block extraction for large files
│       ├── logging.js         # Structured logging + correlation IDs
│       └── handlers/          # One module per command + index.js registry
├── tests/                     # Vitest unit + integration (see tests/AGENTS.md)
├── dist/                      # GENERATED ncc bundle — never hand-edit
└── .github/workflows/ci.yml   # test (Node 20+22) · build · dist-drift · npm audit
```

**Where is X?**
- Event routing / lifecycle → `src/index.js`
- Command parsing + allowlist → `src/lib/commands.js`
- Authorization (collaborator + fork policy) → `src/lib/auth.js`
- Comment posting / threading / reactions → `src/lib/comments.js`
- Z.ai HTTP client + retry → `src/lib/api.js`
- Large-PR batching + synthesis → `src/lib/auto-review.js` (driven by `src/index.js:runLargePrReview`)
- PR file/content fetching for handlers → `src/lib/pr-context.js`
- Adding a command → new module in `src/lib/handlers/`, register in `src/lib/commands.js` `ALLOWED_COMMANDS` and in the dispatch path

---

## 4. Life of a Request / Primary Data Flow

Two entry paths share the orchestrator and the external-service layer.

### Path A — PR auto-review (`pull_request` opened / synchronize)

```text
GitHub: pull_request
  └─ src/index.js:run()
       ├─ events.js:shouldProcessEvent()          → drop bots / unsupported actions
       └─ handlePullRequestEvent()
            ├─ changed-files.js:fetchAllChangedFiles()   → file list (cap 3000)
            ├─ auto-review.js:isLargePr()
            │     ├─ no  → single review prompt
            │     └─ yes → runLargePrReview()
            │              ├─ auto-review.js:createReviewBatches()  (char/file/patch caps)
            │              ├─ executeReviewBatch() per batch → api.js
            │              └─ buildSynthesisPrompt() → api.js
            ├─ api.js:createApiClient()…call()           → Z.ai chat completions
            └─ comments.js:upsertComment(marker=COMMENT_MARKER)  → idempotent review comment
```

### Path B — comment command (`issue_comment` / `pull_request_review_comment`)

```text
GitHub: *comment containing /zai or @zai-bot
  └─ src/index.js:run()
       ├─ events.js:shouldProcessEvent()          → PR-only, drop bots
       └─ handleIssueCommentEvent() / handlePullRequestReviewCommentEvent()
            ├─ commands.js:parseCommand()         → { command, args } against ALLOWED_COMMANDS
            ├─ enforceCommandAuthorization()
            │     └─ auth.js:checkForkAuthorization()   (collaborator OR fork-PR creator)
            ├─ comments.js:setReaction(THINKING)
            ├─ dispatchCommand()                  → handler in src/lib/handlers/
            │     ├─ pr-context.js / context.js   → bounded PR context (truncateContext)
            │     ├─ api.js                       → Z.ai
            │     └─ comments.js:upsertComment({ replyToId })  → threaded reply
            └─ comments.js:setReaction(ROCKET | X)
```

Continuity across turns is carried by hidden markers in prior bot comments (`src/lib/continuity.js`), not by external storage (`Observed`).

---

## 5. Architectural Invariants & Constraints

- **Rule**: The generated bundle `dist/index.js` is the only artifact GitHub executes at runtime; source under `src/` is never loaded at runtime.
  - **Rationale**: `action.yml` points `main` at `dist/index.js`; ncc bundles all dependencies into it.
  - **Enforcement / Signals (Observed)**: `action.yml`; CI `dist-drift` job in `.github/workflows/ci.yml` fails if `dist/` diverges from a fresh `npm run build`.

- **Rule**: Every source change must be shipped together with a rebuilt `dist/`.
  - **Rationale**: Otherwise the Action runs stale logic.
  - **Enforcement / Signals (Observed)**: CI `dist-drift` gate; `npm run build` script in `package.json`.

- **Rule**: Command handlers must run only after authorization succeeds.
  - **Rationale**: Prevents unauthorized users from consuming Z.ai quota or injecting prompts.
  - **Enforcement / Signals (Observed)**: `enforceCommandAuthorization()` calls `auth.js:checkForkAuthorization()` before `dispatchCommand()` in both comment handlers in `src/index.js`.

- **Rule**: Commands are restricted to `ALLOWED_COMMANDS`; unknown input returns help, never execution.
  - **Rationale**: Predictable, bounded command surface.
  - **Enforcement / Signals (Observed)**: allowlist + `parseCommand`/`isValid` in `src/lib/commands.js`.

- **Rule**: All bot comments are idempotent via a unique HTML marker, and command replies are threaded to the invoking comment.
  - **Rationale**: Prevents duplicate review spam; keeps command replies contextual.
  - **Enforcement / Signals (Observed)**: marker constants (`COMMENT_MARKER`, `PROGRESS_MARKER`, `GUIDANCE_MARKER`, `AUTH_MARKER`) in `src/index.js`; `upsertComment(..., marker, { replyToId })` in `src/lib/comments.js`.

- **Rule**: Prompt context is always bounded — never pass unbounded file content to the model.
  - **Rationale**: Avoids token overflow and API failures on large files and PRs.
  - **Enforcement / Signals (Observed)**: `context.js:truncateContext` (`DEFAULT_MAX_CHARS = 8000`), `code-scope.js` windowing, `pr-context.js` large-file scoping, `auto-review.js` batch/char/patch caps plus the synthesis path, `changed-files.js` 3000-file API cap.

- **Rule**: Errors surfaced to users must be sanitized; raw stack traces and secrets must never reach PR comments.
  - **Rationale**: Comments are public; `ZAI_API_KEY` is a secret.
  - **Enforcement / Signals (Observed)**: `sanitizeErrorMessage`, `categorizeError`, and `callWithRetry` in `src/lib/api.js`.

- **Rule**: The bot must never process its own comments as commands.
  - **Rationale**: Prevents feedback loops.
  - **Enforcement / Signals (Observed)**: bot filtering in `events.js:shouldProcessEvent()`; marker-tagged comment bodies.

- **Rule**: Dependency direction is strictly orchestrator → services → handlers → externals; no back-edges.
  - **Rationale**: Keeps the handler set swappable and services reusable.
  - **Enforcement / Signals (Observed)**: require graph in `src/` — no handler imports a sibling handler or a service that imports a handler; `handlers/index.js` is the only module that imports handlers.

- **Rule**: No linter/formatter configuration is present; correctness is enforced by tests and CI gates, not style tooling.
  - **Rationale**: Repository convention.
  - **Enforcement / Signals (Observed)**: absence of ESLint/Prettier configs; `npm test` (Vitest) and `npm audit --audit-level=moderate` in `.github/workflows/ci.yml`.

---

## 6. Documentation Strategy

This `ARCHITECTURE.md` is the **global map + invariants** document: it describes the whole system's shape, boundaries, primary flows, and the rules every change must preserve. It intentionally avoids per-module implementation detail.

Local, finer-grained guidance lives in the `AGENTS.md` tree, which complements this file:
- `AGENTS.md` (root) — repo-wide contributor knowledge base.
- `src/lib/AGENTS.md` — service-module map and conventions.
- `src/lib/handlers/AGENTS.md` — per-handler responsibilities and change rules.
- `tests/AGENTS.md` and `tests/integration/AGENTS.md` — test layout and conventions.

Operational and contributor docs by path (no links): `README.md` (user-facing usage and features), `RUNBOOK.md` (operations), `CONTRIBUTING.md` (contribution guide), `SECURITY.md` (security policy).

What belongs where: global structural facts, boundaries, entrypoints, and invariants belong here; module-level "how this file works", local gotchas, and test conventions belong in the nearest `AGENTS.md`. When code and docs disagree, prefer observable code/config and update the docs.
