# AGENTS.md

## Repository overview

JavaScript GitHub Action (`action.yml`: `node20` runtime, entrypoint `dist/index.js`) with three event-driven flows:
1. **PR auto-review** — `pull_request` opened/synchronize triggers batched diff review via Z.ai.
2. **`/zai` commands** — collaborator-gated PR comment commands (`ask`, `review`, `explain`, `describe`, `impact`, `update-agents`, `help`).
3. **Scheduled tasks** — cron-triggered `.zai-scheduled.yml` tasks that regenerate AGENTS.md files and open PRs.

GitHub executes the ncc-bundled `dist/index.js`. Maintained source lives in `src/index.js` and `src/lib/*`.

## Where to work

```text
src/index.js                        # Runtime entrypoint: event routing + dispatch
src/lib/                            # Services layer (commands/auth/context/comments/api/logging)
src/lib/handlers/                   # Per-command logic (see src/lib/handlers/AGENTS.md)
src/lib/config/scheduled-config.js  # Scheduled-task config loader (.zai-scheduled.yml)
tests/                              # Vitest v3 suite (see tests/AGENTS.md)
action.yml                          # Action inputs + node20 contract
.zai-scheduled.yml                  # This repo's scheduled-task config
dist/index.js                       # Generated ncc bundle (DO NOT hand-edit)
```

## Architecture and boundaries

Three layers with strictly downward dependency direction (full map in `ARCHITECTURE.md`):

1. **Orchestration** — `src/index.js`: event classification, auto-review pipeline, command parse → authorize → dispatch.
2. **Services** — `src/lib/*.js`: cross-cutting infrastructure (commands, auth, context, comments, api, logging, continuity, code-scope).
3. **Handlers** — `src/lib/handlers/*.js`: per-command prompt construction, API wiring, response formatting.

Invariants (detailed in `ARCHITECTURE.md` §5):
- `dist/index.js` is the only artifact GitHub executes; CI `dist-drift` gate fails on uncommitted bundle changes.
- Command handlers run only after `enforceCommandAuthorization` succeeds.
- Automated comments use marker constants for idempotency; replies threaded via `replyToId`.
- No raw exception internals or secrets in PR comments — route through `src/lib/logging.js` safe-error wrappers.
- Prompt sizing bounded via `src/lib/code-scope.js` and `src/lib/context.js`; never unbounded diffs.

## Context routing

Read only when relevant:
- Architectural or cross-module changes → `ARCHITECTURE.md`
- Security or authorization changes → `SECURITY.md`
- Operational/rollback procedures → `RUNBOOK.md`
- Scheduled-task configuration, cron syntax, troubleshooting → `docs/scheduled-tasks.md`
- Contribution guide and review checklists → `CONTRIBUTING.md`
- Test strategy and suite layout → `tests/AGENTS.md`
- Handler-specific rules and scheduled-module internals → `src/lib/handlers/AGENTS.md`
- Services-layer module guide → `src/lib/AGENTS.md`

## Change rules

- Edit source in `src/`; never hand-edit `dist/index.js`.
- After source changes: run `npm run build`, then commit `dist/index.js` + `dist/licenses.txt`.
- Keep command allowlist strict in `src/lib/commands.js` (`ALLOWED_COMMANDS`); `update-agents` is allowed.
- Preserve marker constants (`<!-- zai-code-review -->`, `<!-- zai-progress -->`, `<!-- zai-guidance -->`, `<!-- zai-auth -->`) — tests depend on them.
- Command responses must stay threaded to the invoking comment (`replyToId`).
- Keep prompts bounded; use `src/lib/code-scope.js` for token/char budgeting.
- Return `{ success, error }`-style outcomes where the pattern is already established.
- Prefer pure helpers for parsing/validation; keep handlers decoupled from Octokit via shared context structures.

## Validation

```bash
npm test          # vitest run --coverage
npm run build     # ncc build src/index.js -o dist --license licenses.txt
```

CI (`.github/workflows/ci.yml`) runs test/build/dist-drift/security-audit gates. Coverage uploaded to Codecov.

## Where to look

| Task | Location | Notes |
|------|----------|-------|
| Event routing and dispatch | `src/index.js` | `run()`, PR path, issue_comment path, schedule path |
| Command parsing + allowlist | `src/lib/commands.js` | `/zai` parser, `@zai-bot` normalization, `update-agents` in allowlist |
| Authorization + fork policy | `src/lib/auth.js` | `checkForkAuthorization`, `getCommenter`; permissive for identifiable users |
| Comment lifecycle | `src/lib/comments.js` | Marker upsert, threaded replies (`replyToId`), reactions |
| API retry/error handling | `src/lib/api.js`, `src/lib/logging.js` | Progressive timeout, categorized safe errors |
| Large PR batching + synthesis | `src/lib/auto-review.js` | `createReviewBatches`, context-limit splitting, synthesis prompt |
| Paginated changed-files | `src/lib/changed-files.js` | 3000-file API ceiling (`MAX_PR_FILES_API_LIMIT`) |
| PR context fetch | `src/lib/pr-context.js` | `fetchPrFiles`, `fetchFileAtRef`, `resolvePrRefs`; user-safe fallbacks |
| Token budget calculation | `src/lib/code-scope.js` | Window/enclosing-block extraction |
| Scheduled config loading | `src/lib/config/scheduled-config.js` | `loadScheduledConfig`, `getTasksToRun`, `getGistUrl`, `validateAgentsConfig` |
| Scheduled execution | `src/lib/handlers/scheduled.js` | `handleScheduledEvent`, `handleUpdateAgentsTask`, `SCHEDULED_HANDLERS` |
| Repo context for AGENTS.md gen | `src/lib/repository-context.js` | `collectRepositoryContext`, `renderRepositoryContext` |
| AGENTS.md output validation | `src/lib/agents-validation.js` | `validateGeneratedAgentFiles` — hallucination guard |
| Manual `/zai update-agents` | `src/index.js` (`dispatchCommand`) | Reuses `handleUpdateAgentsTask` |
| Action inputs contract | `action.yml` | `ZAI_API_KEY`, `ZAI_MODEL`, `ZAI_AUTO_REVIEW_*`, `ZAI_SCHEDULED_*`, `ZAI_AGENTS_GIST_URL` |

## Code map

| Symbol | Location | Role |
|--------|----------|------|
| `run` | `src/index.js` | Top-level event gate + dispatcher |
| `handlePullRequestEvent` | `src/index.js` | PR auto-review flow |
| `handleIssueCommentEvent` | `src/index.js` | Command parse/auth/progress/dispatch flow |
| `handlePullRequestReviewCommentEvent` | `src/index.js` | Inline review comment command flow |
| `dispatchCommand` | `src/index.js` | Handler selection and response management |
| `enforceCommandAuthorization` | `src/index.js` | Auth gate before command dispatch |
| `parseCommand` | `src/lib/commands.js` | Command extraction, normalization, allowlist validation |
| `checkForkAuthorization` | `src/lib/auth.js` | Fork-aware authorization policy |
| `buildHandlerContext` | `src/lib/context.js` | Shared context structure for handlers |
| `upsertComment` | `src/lib/comments.js` | Marker-idempotent comment create/update + threaded reply |
| `callWithRetry` | `src/lib/api.js` | Progressive-timeout retry/backoff wrapper |
| `createReviewBatches` | `src/lib/auto-review.js` | Large-PR file chunking by priority + budget |
| `isLargePr` | `src/lib/auto-review.js` | Threshold check for batched mode |
| `fetchAllChangedFiles` | `src/lib/changed-files.js` | Paginated file list (3000 ceiling) |
| `fetchPrFiles` / `fetchFileAtRef` | `src/lib/pr-context.js` | PR file list + content at ref with size limits |
| `extractWindow` / `extractEnclosingBlock` | `src/lib/code-scope.js` | Prompt scoping for explain/review |
| `getEventType` / `shouldProcessEvent` | `src/lib/events.js` | Event-type detection; cron always processed |
| `loadScheduledConfig` | `src/lib/config/scheduled-config.js` | Parses `.zai-scheduled.yml` |
| `handleScheduledEvent` | `src/lib/handlers/scheduled.js` | Scheduled pipeline entry |
| `handleUpdateAgentsTask` | `src/lib/handlers/scheduled.js` | Grounded AGENTS.md regen: context → prompt → validate → PR |
| `collectRepositoryContext` | `src/lib/repository-context.js` | Git tree + existing AGENTS.md discovery + key files |
| `validateGeneratedAgentFiles` | `src/lib/agents-validation.js` | Pre-PR guard: rejects non-AGENTS paths, out-of-scope writes, hallucinated content |

## Repository-specific gotchas

- `dist/index.js` must be committed — the Actions runner does not run `npm install` or build steps.
- `REACTIONS.THINKING` maps to `'eyes'` (not a distinct reaction) in `src/lib/comments.js`.
- `checkAuthorization` in `src/lib/auth.js` currently returns `authorized: true` for any identifiable user; `checkForkAuthorization` delegates to it for non-fork PRs. Legacy collaborator-check code is present but unreachable.
- The `scheduled` handler is exported from `src/lib/handlers/index.js` but is NOT in the `/zai` HANDLERS dispatch map — it runs via the schedule event path and manual `/zai update-agents`.
- `isContextLimitError` in `auto-review.js` triggers automatic sub-batch splitting during large-PR review.
- Gist URL priority: `task.config.gist_url` > `defaults.gist_url` > `ZAI_AGENTS_GIST_URL` env/input.
- `yaml` package (devDependency) is bundled by ncc; scheduled-config parsing depends on it.
