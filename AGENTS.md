# AGENTS.md

## Repository overview

JavaScript GitHub Action (`zai-code-bot`) that runs inside the GitHub Actions runtime (Node 20) on webhook events. Three event flows:

1. **PR auto-review** on `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`) — paginated changed-files fetch, large-PR batching, single synthesized review.
2. **Collaborator-gated `/zai` commands** from `issue_comment` and `pull_request_review_comment` — `ask`, `review`, `explain`, `describe`, `impact`, `update-agents`, `help`.
3. **Scheduled tasks** (`schedule` cron) driven by `.zai-scheduled.yml` — the `update-agents` task regenerates `AGENTS.md` files and opens a PR only when something changed.

Runtime contract: GitHub executes **only** `dist/index.js` (ncc bundle). Maintained logic lives in `src/`. CI fails on `dist/` drift.

## Where to work

```text
zai-code-bot/
├── src/index.js                 # Runtime entrypoint: event routing + dispatch
├── src/lib/                     # Services (parsing, auth, context, comments, API)
│   ├── handlers/                # Per-command + scheduled handlers
│   └── config/scheduled-config.js
├── tests/                       # Vitest v3 suite (unit + integration/)
├── dist/                        # Generated ncc bundle (CI-executed; do not hand-edit)
├── action.yml                   # Action inputs + Node 20 runtime contract
├── .zai-scheduled.yml           # Scheduled-task config for THIS repo
├── .zai-scheduled.yml.template  # Consumer template
├── .github/workflows/           # ci.yml, zai-code-bot.yml, zai-agents-update.yml, zai-agents-init-example.yml
├── docs/scheduled-tasks.md      # Scheduled-tasks configuration reference
├── plans/                       # Planning docs (scheduled-tasks integration)
├── ARCHITECTURE.md              # Layered architecture + invariants catalog
├── CONTRIBUTING.md              # Contribution guide + senior review checklists
├── RUNBOOK.md                   # Operational runbook + rollback procedures
└── SECURITY.md                  # Authorization rules + permission model
```

## Architecture and boundaries

Strict three-layer dependency direction (downward only):

```text
GitHub Actions runtime → src/index.js (orchestration)
                       → src/lib/*.js (services)
                       → src/lib/handlers/*.js (commands) → src/lib/api.js + src/lib/pr-context.js (external I/O)
```

Non-negotiable invariants (full catalog in `ARCHITECTURE.md`):

- GitHub runs `dist/index.js` only; rebuild via `npm run build` and commit `dist/index.js` + `dist/licenses.txt` together after any `src/` change.
- Command handlers run only after `enforceCommandAuthorization` succeeds (collaborator + fork policy in `src/lib/auth.js`).
- Issue comments on non-PR issues never dispatch handlers.
- Handlers receive shared context and call services (`api.js`, `pr-context.js`, `comments.js`); they do not touch Octokit ad hoc.
- Automated comments are marker-idempotent and threaded via `replyToId`. Marker constants live in `src/index.js`: `COMMENT_MARKER`, `PROGRESS_MARKER`, `GUIDANCE_MARKER`, `AUTH_MARKER`.
- No raw exception internals or secrets in PR comments; route through categorized safe errors in `src/lib/logging.js`.

## Context routing

Read only when relevant:

- Cross-module or architectural changes → `ARCHITECTURE.md` (layers, dependency direction, life-of-request flows, full invariant catalog)
- Release, versioning, senior review checklists → `CONTRIBUTING.md`
- Rollback / incident response → `RUNBOOK.md`
- Authorization rules and permission model → `SECURITY.md`
- Scheduled-task config (cron syntax, scoping fields, troubleshooting) → `docs/scheduled-tasks.md`
- Services-layer conventions → `src/lib/AGENTS.md`
- Per-command handler conventions → `src/lib/handlers/AGENTS.md`
- Test layout and suite conventions → `tests/AGENTS.md`
- End-to-end pipeline test conventions → `tests/integration/AGENTS.md`

## Where to look

| Task | Location | Notes |
|------|----------|-------|
| Event routing and dispatch | `src/index.js` | `run()`, `handlePullRequestEvent`, `handleIssueCommentEvent`, `handlePullRequestReviewCommentEvent`, `dispatchCommand` |
| Schedule event detection | `src/lib/events.js` | `getEventType` returns `schedule`; `shouldProcessEvent` always processes cron |
| `/zai` parser + allowlist | `src/lib/commands.js` | `parseCommand`, `ALLOWED_COMMANDS` (incl. `update-agents`), `@zai-bot` normalization |
| Authorization + fork policy | `src/lib/auth.js` | `checkForkAuthorization`, `getCommenter`; silent block for non-identifiable commenters on fork PRs |
| Comment lifecycle | `src/lib/comments.js` | `upsertComment` (marker idempotency, threaded reply), `REACTIONS` |
| Z.ai HTTP client + retry | `src/lib/api.js` | `createApiClient`, `callWithRetry`, progressive timeout, fallback prompts |
| Large-PR batching + synthesis | `src/lib/auto-review.js` | `createReviewBatches`, `buildSynthesisPrompt`, `buildFallbackReview`, `isContextLimitError` |
| Paginated changed-files fetch | `src/lib/changed-files.js` | `fetchAllChangedFiles`, `MAX_PR_FILES_API_LIMIT` (3000) |
| Shared PR context fetch | `src/lib/pr-context.js` | `fetchPrFiles`, `fetchFileAtRef`, `resolvePrRefs` |
| Token/char budget for prompts | `src/lib/code-scope.js` | `extractWindow`, `extractTargetBlock`, `extractEnclosingBlock` |
| Truncation / range helpers | `src/lib/context.js` | `extractLines`, `validateRange`, `buildHandlerContext` |
| Hidden marker state | `src/lib/continuity.js` | `loadContinuityState`, `mergeState`, `createCommentWithState` |
| Scheduled config loader | `src/lib/config/scheduled-config.js` | `loadScheduledConfig`, `getTasksToRun`, `validateAndNormalizeConfig`, `validateAgentsConfig`, `getGistUrl` |
| Scheduled pipeline executor | `src/lib/handlers/scheduled.js` | `handleScheduledEvent`, `executeScheduledTask`, `handleUpdateAgentsTask` |
| Repo context for AGENTS.md gen | `src/lib/repository-context.js` | `collectRepositoryContext`, `renderRepositoryContext` |
| AGENTS.md output validation | `src/lib/agents-validation.js` | `validateGeneratedAgentFiles` (hallucination guard from PR #15) |

## Code map

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `run` | function | `src/index.js` | Top-level event gate + dispatcher |
| `handlePullRequestEvent` | function | `src/index.js` | PR auto-review flow |
| `handleIssueCommentEvent` | function | `src/index.js` | Command parse/auth/progress/dispatch |
| `handlePullRequestReviewCommentEvent` | function | `src/index.js` | Inline review-comment command flow |
| `dispatchCommand` | function | `src/index.js` | Handler selection + response management |
| `enforceCommandAuthorization` | function | `src/index.js` | Auth gate before dispatch |
| `parseCommand` | function | `src/lib/commands.js` | `/zai` parser + allowlist |
| `checkForkAuthorization` | function | `src/lib/auth.js` | Fork-aware authorization policy |
| `upsertComment` | function | `src/lib/comments.js` | Marker idempotency + threaded reply |
| `createApiClient` / `callWithRetry` | function | `src/lib/api.js` | Z.ai client with progressive timeout + fallback |
| `createReviewBatches` | function | `src/lib/auto-review.js` | Large-PR chunking with priority scoring |
| `fetchAllChangedFiles` | function | `src/lib/changed-files.js` | Paginated list (3000-file API ceiling) |
| `fetchPrFiles` / `fetchFileAtRef` / `resolvePrRefs` | function | `src/lib/pr-context.js` | PR file/content/ref fetch with safe fallbacks |
| `extractWindow` / `extractTargetBlock` / `extractEnclosingBlock` | function | `src/lib/code-scope.js` | Window/target/enclosing-block extraction for prompt budgets |
| `getEventType` / `shouldProcessEvent` | function | `src/lib/events.js` | Event-type detection (incl. `schedule`) |
| `loadScheduledConfig` / `getTasksToRun` / `getGistUrl` | function | `src/lib/config/scheduled-config.js` | `.zai-scheduled.yml` parsing + scoping validation |
| `handleScheduledEvent` / `executeScheduledTask` / `handleUpdateAgentsTask` | function | `src/lib/handlers/scheduled.js` | Cron-driven pipeline + grounded AGENTS.md regen |
| `SCHEDULED_HANDLERS` | constant | `src/lib/handlers/scheduled.js` | Command→handler registry |
| `collectRepositoryContext` / `renderRepositoryContext` | function | `src/lib/repository-context.js` | Git tree + AGENTS.md discovery + key-file contents |
| `validateGeneratedAgentFiles` | function | `src/lib/agents-validation.js` | Pre-PR guard: rejects non-AGENTS paths, out-of-scope writes, hallucinated content |

## Change rules

- Edit `src/`, never hand-edit `dist/`.
- After source changes: `npm run build`, then commit `dist/index.js` + `dist/licenses.txt` together with `src/`.
- Keep `ALLOWED_COMMANDS` strict in `src/lib/commands.js`; adding a command requires parser + handler + dispatch + tests.
- Marker constants (`COMMENT_MARKER`, `PROGRESS_MARKER`, `GUIDANCE_MARKER`, `AUTH_MARKER`) must stay stable; tests depend on them.
- Scheduled tasks must go through `validateGeneratedAgentFiles` before opening a PR — never bypass the hallucination guard.
- Scoping config in `.zai-scheduled.yml` (`context_paths`, `target_paths`, `exclude_paths`, `max_context_chars`, `max_file_chars`, `max_files_to_fetch`, `allow_create_new`, `update_existing_only`) is enforced by `validateAgentsConfig`.
- Gist URL priority is first-non-empty-wins: `task.config.gist_url` > `defaults.gist_url` > `ZAI_AGENTS_GIST_URL`.

## Validation

- Tests: `npm test` → `vitest run --coverage` (Vitest v3 with globals; config in `vitest.config.js`).
- Build: `npm run build` → `ncc build src/index.js -o dist --license licenses.txt`.
- CI gates (`.github/workflows/ci.yml`): test, build, `dist/` drift check, security audit.
- Coverage uploaded to Codecov.
- When changing comment markers or command UX, update both unit and `tests/integration/` assertions.

## Repository-specific gotchas

- The auto-review path silently switches to batched mode past `ZAI_AUTO_REVIEW_LARGE_PR_FILE_THRESHOLD` (default 50 patchable files) and synthesizes a final review; `isContextLimitError` triggers sub-batch halving on 413-style errors.
- GitHub's changed-files API caps at 3000 files; coverage notes flag incomplete review beyond that ceiling.
- `REACTIONS.THINKING` is mapped to `'eyes'` (not a distinct emoji) in `src/lib/comments.js` — preserve unless deliberately changing.
- The `update-agents` task is exposed both as a scheduled task and as a manual `/zai update-agents` command (both reuse `handleUpdateAgentsTask`).
- Scheduled AGENTS.md generation tells the model it has **NO live repo access**; all context is embedded from `collectRepositoryContext`. Output is validated against the real tree before any PR.
- `auth.js` currently uses a permissive policy (`identifiable_user` short-circuits) but the fork silent-block path for non-identifiable commenters must remain intact.
