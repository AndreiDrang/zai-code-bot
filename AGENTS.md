# AGENTS.md

## Repository overview

JavaScript GitHub Action (`action.yml`: `using: "node20"`, `main: "dist/index.js"`) with three event-driven flows:
1. **PR auto-review** on `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`).
2. **Collaborator-gated `/zai` commands** from `issue_comment` and `pull_request_review_comment` events.
3. **Cron-triggered scheduled tasks** (`.zai-scheduled.yml`) that regenerate `AGENTS.md` files and open PRs.

The GitHub Actions runner executes the generated `dist/index.js` bundle; maintained logic lives in `src/`. This is not a server and not a published library (`package.json` has only `build` and `test` scripts).

## Where to work

```text
src/index.js                       # Runtime orchestration: event routing + dispatch
src/lib/                           # Services: auth, commands, context, comments, api, ...
src/lib/handlers/                  # Per-command modules (incl. scheduled.js)
src/lib/config/scheduled-config.js # `.zai-scheduled.yml` loader + scoping validation
tests/                             # Vitest v3 unit + integration suites
dist/index.js                      # Generated ncc bundle (CI runs this; do not hand-edit)
action.yml                         # Action inputs + node20 runtime contract
.zai-scheduled.yml                 # This repo's scheduled-task config
.zai-scheduled.yml.template        # Consumer template for scheduled tasks
```

## Architecture and boundaries

Three strictly downward layers (full map, data flows, and invariant catalog live in `ARCHITECTURE.md`):

1. **Orchestration** — `src/index.js`. The only module that reads `github.context` directly.
2. **Services** — `src/lib/*.js`. Command-agnostic infrastructure.
3. **Handlers** — `src/lib/handlers/*.js`. Per-command logic.

Broadly-applicable invariants:
- The runner executes `dist/index.js` only; source changes require `npm run build` and committing `dist/index.js` + `dist/licenses.txt`. CI fails on `dist/` drift.
- Command handlers run only after `enforceCommandAuthorization` succeeds (`src/index.js` → `src/lib/auth.js`).
- Command execution is scoped to PR contexts — non-PR issue comments must not dispatch.
- External I/O (Z.ai, GitHub) is funneled through `src/lib/api.js` and `src/lib/pr-context.js`; handlers do not call Octokit ad hoc.
- Automated comments are idempotent via marker constants and threaded via `replyToId`.
- No raw exception internals or secrets in PR comments; failures route through `src/lib/logging.js` categorization.

## Context routing

Read only when the change type matches:

- Architectural or cross-module changes → `ARCHITECTURE.md` (layered architecture, life-of-request, full invariants)
- Operational incidents / rollbacks → `RUNBOOK.md`
- Authorization and permission model → `SECURITY.md`
- Review checklists, versioning, release steps → `CONTRIBUTING.md`
- Scheduled-tasks configuration, cron syntax, troubleshooting → `docs/scheduled-tasks.md`
- Per-command handler rules → `src/lib/handlers/AGENTS.md`
- Services-layer rules → `src/lib/AGENTS.md`
- Test conventions → `tests/AGENTS.md`, `tests/integration/AGENTS.md`

## Where to look (task-based)

| Task | Location | Notes |
|------|----------|-------|
| Event routing / dispatch | `src/index.js` | `run()`, PR path, issue_comment path, schedule path |
| Schedule event detection | `src/lib/events.js` | `getEventType` returns `schedule`; `shouldProcessEvent` always processes cron events |
| Command parsing + allowlist | `src/lib/commands.js` | `/zai` parser, `ALLOWED_COMMANDS` incl. `update-agents`, `COMMAND_DESCRIPTIONS` |
| Authorization / fork policy | `src/lib/auth.js` | Currently permissive: any identifiable user is authorized; silent block otherwise |
| Comment lifecycle | `src/lib/comments.js` | Marker-based upsert, threaded reply (`replyToId`), reactions |
| API retry / error handling | `src/lib/api.js`, `src/lib/logging.js` | Progressive timeout, exponential backoff, categorized safe errors |
| Large PR batching / synthesis | `src/lib/auto-review.js` | `createReviewBatches`, `buildSynthesisPrompt`, `buildFallbackReview` |
| Paginated changed-files fetch | `src/lib/changed-files.js` | `MAX_PR_FILES_API_LIMIT = 3000` (GitHub API ceiling) |
| Shared PR context fetch | `src/lib/pr-context.js` | `fetchPrFiles`, `fetchFileAtRef`, `resolvePrRefs`; user-safe fallbacks |
| Token-budget calculation | `src/lib/code-scope.js` | Window extraction, enclosing block detection |
| Scheduled-task config | `src/lib/config/scheduled-config.js` | `loadScheduledConfig`, `getTasksToRun`, `validateAndNormalizeConfig`, `getGistUrl`, `validateAgentsConfig` |
| Scheduled-task execution | `src/lib/handlers/scheduled.js` | `handleScheduledEvent`, `handleUpdateAgentsTask`, `SCHEDULED_HANDLERS` |
| Repository context for AGENTS.md gen | `src/lib/repository-context.js` | `collectRepositoryContext`, `renderRepositoryContext` |
| AGENTS.md output validation | `src/lib/agents-validation.js` | `validateGeneratedAgentFiles` — hallucination guard (PR #15 regression) |
| Manual `/zai update-agents` | `src/index.js` (`dispatchCommand`) | Reuses `handleUpdateAgentsTask` |

## Code map (key symbols)

| Symbol | Location | Role |
|--------|----------|------|
| `run` | `src/index.js` | Top-level event gate + dispatcher |
| `handlePullRequestEvent` | `src/index.js` | PR auto-review flow |
| `handleIssueCommentEvent` | `src/index.js` | Command parse → auth → progress → dispatch |
| `handlePullRequestReviewCommentEvent` | `src/index.js` | Inline review-comment command flow |
| `dispatchCommand` | `src/index.js` | Handler selection + response management |
| `enforceCommandAuthorization` | `src/index.js` | Auth gate before command dispatch |
| `parseCommand` / `isValid` | `src/lib/commands.js` | Command extraction + allowlist |
| `checkForkAuthorization` | `src/lib/auth.js` | Fork-aware authorization |
| `getCommenter` | `src/lib/auth.js` | Comment author extraction |
| `upsertComment` / `setReaction` | `src/lib/comments.js` | Marker idempotency + threaded replies + reactions |
| `createApiClient` / `callWithRetry` | `src/lib/api.js` | Z.ai HTTP client + retry wrapper |
| `createReviewBatches` / `buildSynthesisPrompt` | `src/lib/auto-review.js` | Large-PR batching and synthesis |
| `fetchAllChangedFiles` | `src/lib/changed-files.js` | Paginated file list (3000-file ceiling) |
| `fetchPrFiles` / `fetchFileAtRef` / `resolvePrRefs` | `src/lib/pr-context.js` | Shared PR context fetch |
| `extractWindow` / `extractEnclosingBlock` | `src/lib/code-scope.js` | Prompt token-budget scoping |
| `getEventType` / `shouldProcessEvent` | `src/lib/events.js` | Event-type detection incl. `schedule` |
| `loadScheduledConfig` / `getTasksToRun` / `getGistUrl` / `validateAgentsConfig` | `src/lib/config/scheduled-config.js` | `.zai-scheduled.yml` parsing and scoping |
| `handleScheduledEvent` / `executeScheduledTask` / `handleUpdateAgentsTask` | `src/lib/handlers/scheduled.js` | Scheduled pipeline + grounded AGENTS.md regen |
| `SCHEDULED_HANDLERS` / `registerScheduledHandler` | `src/lib/handlers/scheduled.js` | Scheduled-handler registry |
| `buildAgentsUpgradePrompt` / `parseFileUpdatesFromResponse` / `callZaiApiWithRetry` / `fetchFromUrl` / `createPR` | `src/lib/handlers/scheduled.js` | AGENTS.md regen helpers |
| `collectRepositoryContext` / `renderRepositoryContext` | `src/lib/repository-context.js` | Real repo context collection for prompts |
| `validateGeneratedAgentFiles` / `validateFileEntry` / `isAgentsPath` | `src/lib/agents-validation.js` | Pre-PR hallucination guard |

## Change rules

- Edit `src/`, never hand-edit `dist/index.js`.
- After source changes: run `npm run build` and commit `dist/index.js` + `dist/licenses.txt` together.
- Preserve marker constants (`<!-- zai-code-review -->`, `<!-- zai-progress -->`, `<!-- zai-guidance -->`, `<!-- zai-auth -->`); changing them breaks idempotent upserts.
- Keep command replies threaded (`replyToId`); do not post top-level comments for command results.
- Keep prompts bounded via `src/lib/code-scope.js` / `src/lib/context.js`; never pass raw unbounded patches.
- Adding a `/zai` command: extend `ALLOWED_COMMANDS` + `COMMAND_DESCRIPTIONS` in `src/lib/commands.js`, create the handler in `src/lib/handlers/`, register it in `src/lib/handlers/index.js`, and wire it into the dispatch switch in `src/index.js`.
- Adding a scheduled task: register via `SCHEDULED_HANDLERS` / `registerScheduledHandler` in `src/lib/handlers/scheduled.js` (not in the `/zai` HANDLERS map).
- Editing the grounded AGENTS.md regen flow: preserve the order collect → prompt → validate → diff → PR; bypassing `validateGeneratedAgentFiles` reintroduces the PR #15 hallucination failure.

## Validation

- `npm test` → `vitest run --coverage` (Vitest v3 with globals; configured via `vitest.config.js`).
- `npm run build` → `ncc build src/index.js -o dist --license licenses.txt`.
- CI (`.github/workflows/ci.yml`) gates on test, build, dist-drift, and security audit.
- Coverage is uploaded to Codecov.

## Key docs

- `ARCHITECTURE.md` — layered architecture, dependency direction, life-of-request flows, invariant catalog.
- `RUNBOOK.md` — operational runbook and rollback procedures.
- `SECURITY.md` — authorization rules and permission model.
- `CONTRIBUTING.md` — contribution guide, review checklists, release process.
- `docs/scheduled-tasks.md` — scheduled-tasks configuration reference, cron syntax, troubleshooting.
- `README.md` — user-facing inputs, commands, quickstart.
- `action.yml` — Action inputs (`ZAI_API_KEY`, `ZAI_MODEL`, `ZAI_TIMEOUT`, `ZAI_AUTO_REVIEW_*`, `ZAI_SCHEDULED_*`, `ZAI_AGENTS_GIST_URL`) and node20 runtime contract.

## Repository-specific gotchas

- `src/lib/auth.js` currently uses a **permissive** policy: `checkAuthorization` returns `authorized: true` for any identifiable user. Fork-safety is enforced only by silent blocking when no identifiable user is present. Do not assume strict collaborator-permission checks are active, even though `AUTHORIZED_PERMISSIONS` and `isCollaborator` are still exported.
- `src/lib/comments.js` `REACTIONS.THINKING` is mapped to the string `'eyes'` (GitHub has no `thinking` reaction content type) — `EYES` and `THINKING` produce the same reaction.
- `src/lib/changed-files.js` caps at `MAX_PR_FILES_API_LIMIT = 3000` (GitHub API ceiling); the final review notes incomplete coverage when the limit is reached.
- Large PRs switch to batched mode above `ZAI_AUTO_REVIEW_LARGE_PR_FILE_THRESHOLD` (default `50` patchable files) with per-batch budgets from `ZAI_AUTO_REVIEW_MAX_BATCH_CHARS`, `ZAI_AUTO_REVIEW_MAX_FILES_PER_BATCH`, and `ZAI_AUTO_REVIEW_MAX_PATCH_CHARS`.
- The `scheduled` handler is exported from `src/lib/handlers/index.js` but is **not** in the `/zai` `HANDLERS` map — it is invoked from the `src/index.js` schedule path and from the manual `/zai update-agents` command (which reuses `handleUpdateAgentsTask`).
- `ZAI_MODEL` default is `glm-5.2` (per `action.yml`); the Z.ai endpoint is `https://api.z.ai/api/coding/paas/v4/chat/completions` (hardcoded in both `src/index.js` and `src/lib/api.js`).
- Handler unit tests live under `tests/handlers/` (not alongside `tests/*.test.js`); new handler tests go there.
- End-to-end coverage of the scheduled event → context → Z.ai mock → validated PR is a known gap; the grounded `handleUpdateAgentsTask` flow is unit-tested via the `__callZaiForTest` seam in `tests/handlers/scheduled.test.js`.

## Generated artifacts

- `dist/index.js`, `dist/licenses.txt` — produced by `npm run build`; commit on every source change (CI enforces no drift).
- `AGENTS.md` tree (this file plus children under `src/lib/`, `src/lib/handlers/`, `tests/`, `tests/integration/`) — regenerated by the scheduled `update-agents` task; safe to edit manually between runs.
