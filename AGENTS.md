# AGENTS.md

**Scope:** Repository-wide.
**Child files:** `src/lib/AGENTS.md`, `src/lib/handlers/AGENTS.md`, `tests/AGENTS.md`, `tests/integration/AGENTS.md`.

## Repository overview

JavaScript GitHub Action (Node 20 runtime, `dist/index.js` entrypoint) with three event flows:

1. **PR auto-review** — `pull_request` `opened`/`synchronize`; large PRs are batched and synthesized.
2. **`/zai` commands** — authorization-gated PR comment commands (prefix `/zai` or `@zai-bot`): `ask`, `review`, `explain`, `describe`, `impact`, `update-agents`, `help`.
3. **Scheduled tasks** — cron-triggered `.zai-scheduled.yml` tasks that regenerate AGENTS.md files and open PRs.

GitHub executes the bundled `dist/index.js` (ncc bundle); maintained source lives in `src/`.

## Where to work

```text
src/index.js                         # Event dispatch + pipelines (only module reading github.context)
src/lib/                             # Services: events, commands, auth, context, comments, api, logging, continuity
src/lib/handlers/                    # Per-command + scheduled handlers
src/lib/config/scheduled-config.js   # .zai-scheduled.yml loader
src/lib/repository-context.js        # Repo context collection for AGENTS.md gen
src/lib/agents-validation.js         # Hallucination guard for generated AGENTS.md files
tests/                               # Vitest v3 unit + integration suites
action.yml                           # Action inputs + node20 contract
.zai-scheduled.yml                   # This repo's scheduled-task config (weekly update-agents)
.github/workflows/ci.yml             # CI gates; sibling zai-*.yml workflows run the bot on this repo
dist/index.js                        # Generated ncc bundle (CI executes this)
```

## Architecture boundaries

Three layers, strictly downward dependency:

1. **Orchestration** (`src/index.js`) — event routing, auto-review pipeline, command dispatch (the command `switch` lives in `dispatchCommand`).
2. **Services** (`src/lib/*.js`) — command-agnostic infrastructure.
3. **Handlers** (`src/lib/handlers/*.js`) — per-command logic; receive shared context, never own GitHub I/O directly.

Invariants (detailed rationale in `ARCHITECTURE.md`):

- `dist/index.js` is the sole runtime artifact; `src/` is source-of-truth.
- `enforceCommandAuthorization` always precedes command dispatch.
- Comments are marker-idempotent and threaded (`replyToId`).
- No raw exception internals or secrets surfaced in PR comments.
- External I/O is funneled through `src/lib/api.js` and `src/lib/pr-context.js`.

## Context routing

Read only when relevant:

- Architectural changes or cross-module work → `ARCHITECTURE.md`
- Scheduled-tasks configuration, cron syntax, troubleshooting → `docs/scheduled-tasks.md`
- Scheduled-task design history and rollout plans → `plans/`
- Rollback or incident response → `RUNBOOK.md`
- Authorization model and permission rules → `SECURITY.md`
- Contribution workflow and review checklists → `CONTRIBUTING.md`
- Service-module details → `src/lib/AGENTS.md`
- Handler-specific behavior → `src/lib/handlers/AGENTS.md`
- Test strategy and coverage map → `tests/AGENTS.md`

## Code map

| Symbol | File | Role |
|--------|------|------|
| `run` | `src/index.js` | Event gate + dispatcher |
| `handlePullRequestEvent` | `src/index.js` | PR auto-review flow |
| `handleIssueCommentEvent` | `src/index.js` | Command parse → auth → dispatch |
| `handlePullRequestReviewCommentEvent` | `src/index.js` | Inline review comment command flow |
| `dispatchCommand` | `src/index.js` | Handler selection + response management (the command `switch`) |
| `enforceCommandAuthorization` | `src/index.js` | Auth gate before dispatch |
| `getReviewConfig` | `src/index.js` | Reads auto-review thresholds from `ZAI_AUTO_REVIEW_*` inputs (overridable/injectable for tests) |
| `executeReviewBatch` | `src/index.js` | Per-batch review execution with context-limit sub-splitting |
| `runLargePrReview` | `src/index.js` | Batched review loop + final synthesis (falls back to concatenated batches) |
| `callZaiApi` | `src/index.js` | Direct Z.ai HTTP call (auto-review path) |
| `GUIDANCE_MESSAGES` | `src/index.js` | Parse-error help texts (`unknown_command`, `malformed_input`, `empty_input`); embed the review marker |
| `parseCommand` / `isValid` | `src/lib/commands.js` | `/zai` parser + `ALLOWED_COMMANDS` allowlist enforcement |
| `normalizeInput` | `src/lib/commands.js` | `@zai-bot` (and bare `@zai`) mention → `/zai` normalization |
| `checkForkAuthorization` | `src/lib/auth.js` | Fork-aware auth policy (currently permissive for identifiable users) |
| `checkAuthorization` | `src/lib/auth.js` | Permissive: authorizes any identifiable user |
| `getCommenter` | `src/lib/auth.js` | Extracts commenter: `comment.user` → `sender` → `review.user` → `issue.user` |
| `getPullRequestForAuthorization` | `src/lib/auth.js` | Fetches the PR for issue-comment events |
| `upsertComment` | `src/lib/comments.js` | Marker-idempotent + threaded comments |
| `findCommentByMarker` | `src/lib/comments.js` | Locates existing bot comment by hidden marker |
| `setReaction` | `src/lib/comments.js` | Lifecycle reactions (`eyes`, `rocket`, `-1`) |
| `createApiClient` | `src/lib/api.js` | Factory for Z.ai client with timeout/retry config |
| `withFallback` | `src/lib/api.js` | Client variant with a fallback prompt generator used after timeouts |
| `callWithRetry` | `src/lib/api.js` | Exponential backoff + jitter + progressive timeout (10s floor) |
| `categorizeError` | `src/lib/api.js` | Classifies errors as retryable/non-retryable |
| `createReviewBatches` | `src/lib/auto-review.js` | Large-PR entry creation + priority-sorted chunking |
| `isLargePr` | `src/lib/auto-review.js` | File-count threshold check (default 50 patchable files) |
| `isContextLimitError` | `src/lib/auto-review.js` | Detects 413 / context-length API errors (triggers batch sub-splitting) |
| `buildSynthesisPrompt` | `src/lib/auto-review.js` | Final batch-merge prompt |
| `buildCoverageNotes` | `src/lib/auto-review.js` | Coverage summary for review output |
| `buildFallbackReview` | `src/lib/auto-review.js` | Concatenated per-batch output when synthesis fails |
| `fetchAllChangedFiles` | `src/lib/changed-files.js` | Paginated file list; returns `{ files, pageCount, limitReached }` (3000-file API ceiling) |
| `MAX_PR_FILES_API_LIMIT` | `src/lib/changed-files.js` | GitHub API ceiling constant (3000) |
| `extractWindow` | `src/lib/code-scope.js` | Surrounding-window line extraction (default ±15 lines) |
| `extractEnclosingBlock` | `src/lib/code-scope.js` | Nearest function/class block detection |
| `extractTargetBlock` | `src/lib/code-scope.js` | Exact line-range extraction |
| `getEventType` / `shouldProcessEvent` | `src/lib/events.js` | Event-type detection incl. `schedule` (always processed) |
| `extractReviewCommentAnchor` | `src/lib/events.js` | File/line anchor from review comments |
| `loadContinuityState` / `mergeState` | `src/lib/continuity.js` | Hidden-marker state across turns |
| `createLogger` / `generateCorrelationId` | `src/lib/logging.js` | Categorized safe-error logging |
| `loadScheduledConfig` / `getTasksToRun` | `src/lib/config/scheduled-config.js` | `.zai-scheduled.yml` parsing + schedule matching |
| `validateAndNormalizeConfig` | `src/lib/config/scheduled-config.js` | Schema validation (version 1) + default-merging |
| `getGistUrl` | `src/lib/config/scheduled-config.js` | Gist URL priority: task > defaults > `ZAI_AGENTS_GIST_URL` env |
| `validateAgentsConfig` | `src/lib/config/scheduled-config.js` | Validates scoping fields (`context_paths`, `target_paths`, etc.) |
| `handleScheduledEvent` | `src/lib/handlers/scheduled.js` | Scheduled pipeline entry: load config, run matching tasks |
| `handleUpdateAgentsTask` | `src/lib/handlers/scheduled.js` | Grounded AGENTS.md regen: context → prompt → validate → PR |
| `collectRepositoryContext` | `src/lib/repository-context.js` | Git tree + existing AGENTS.md discovery + key files (budgeted) |
| `renderRepositoryContext` | `src/lib/repository-context.js` | Renders context into compact prompt block |
| `validateGeneratedAgentFiles` | `src/lib/agents-validation.js` | Pre-PR guard: rejects non-AGENTS paths, out-of-scope writes, hallucinated content |
| `validateFileEntry` | `src/lib/agents-validation.js` | Per-file validation (path, scope, hallucination check) |

## Change rules

- Edit source in `src/`; never hand-edit `dist/index.js`.
- After source changes: run `npm run build`, then commit `dist/index.js` + `dist/licenses.txt`.
- CI `dist-drift` gate (`.github/workflows/ci.yml`) fails on uncommitted `dist/` changes.
- Keep the command allowlist strict in `src/lib/commands.js` (`ALLOWED_COMMANDS`); `update-agents` is allowed.
- Preserve comment marker constants (`<!-- zai-code-review -->`, `<!-- zai-progress -->`, `<!-- zai-auth -->`, `<!-- zai-guidance -->`).
- Bound prompts via `src/lib/code-scope.js` and `src/lib/context.js`; never pass unbounded patches.
- Scheduled AGENTS.md output must pass `validateGeneratedAgentFiles` before PR creation.
- Command replies must be threaded (`replyToId`); never post top-level comments for command results.
- Reactions should reflect lifecycle: acknowledge (`eyes`) → work → success (`rocket`) / failure (`-1`).
- New runtime imports under `src/` only take effect after a rebuild — ncc bundles them into `dist/` (e.g. `yaml` is a devDependency yet required at runtime by `scheduled-config.js`).

## Validation

```bash
npm test           # vitest run --coverage
npm run build      # ncc build src/index.js -o dist --license licenses.txt
```

CI gates (`.github/workflows/ci.yml`): test → build → dist-drift → security-audit.

## Gotchas

- `dist/index.js` must be committed; the GitHub Actions runner does not run `npm install` or build steps.
- `REACTIONS.THINKING` maps to `'eyes'` in `src/lib/comments.js` — it is not a distinct emoji.
- `checkAuthorization` / `checkForkAuthorization` currently authorize any identifiable user (permissive policy; legacy collaborator checks removed but `AUTHORIZED_PERMISSIONS`/`AUTHORIZED_ASSOCIATIONS` remain exported). Silent fork-block applies only when no commenter can be identified (`reason: null`).
- GitHub's changed-files API ceiling is 3000 files (`MAX_PR_FILES_API_LIMIT`); review output includes coverage notes when this limit is reached.
- `ZAI_MODEL` default is `glm-5.2`; Z.ai endpoint is `https://api.z.ai/api/coding/paas/v4/chat/completions`.
- Setting `ZAI_DEBUG` enables per-attempt timing/diagnostic logs in `src/lib/api.js`.
- `scheduled-config.js` built-in default schedule is `0 0 * * 0` (Sunday); this repo's `.zai-scheduled.yml` overrides it to `0 0 * * 1` (Monday). A missing config file (404) disables scheduled tasks rather than erroring; the config path can be overridden via `ZAI_SCHEDULED_CONFIG_PATH`.
- The command dispatch `switch` lives in `src/index.js` (`dispatchCommand`), not in `src/lib/handlers/index.js`. The handler registry in `index.js` is consumed by the runtime but `scheduled` is exported separately and not in the `/zai` HANDLERS map.
- `@zai-bot` prefix (and bare `@zai`) is normalized to `/zai` by `normalizeInput` in `src/lib/commands.js`.
- Parse failures surface `GUIDANCE_MESSAGES` from `src/index.js`; these embed `<!-- zai-code-review -->` so guidance replies stay marker-idempotent.
