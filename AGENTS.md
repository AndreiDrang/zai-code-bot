# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-01T00:00:00Z
**Branch:** main
**Refresh:** reconciled against `plans/*` (scheduled-tasks pipeline); verified scheduled event routing, config loader, handler symbols, manual `/zai update-agents` command, action.yml inputs, and line counts. Gaps flagged: no scheduled test coverage, no `docs/`, README not updated.

## OVERVIEW
JavaScript GitHub Action with three event flows: (1) PR auto-review, (2) collaborator-gated `/zai` PR comment commands, and (3) cron-triggered scheduled tasks (`.zai-scheduled.yml`) that regenerate AGENTS.md files and open PRs. Runtime executes bundled `dist/index.js`; maintained logic lives in `src/index.js` plus modular services in `src/lib/*`.

## STRUCTURE
```text
zai-code-bot/
├── src/index.js                      # Runtime orchestration and event dispatch (~1095 lines)
├── src/lib/                          # Commands/auth/context/comments/api/services
├── src/lib/events.js                 # Event-type detection incl. `schedule` (cron) routing
├── src/lib/commands.js               # `/zai` parser + allowlist (incl. `update-agents`)
├── src/lib/auto-review.js            # Large PR batching and synthesis
├── src/lib/changed-files.js          # Paginated changed-files fetch (3000 file limit)
├── src/lib/pr-context.js             # Shared PR context fetch (files, content at ref, refs)
├── src/lib/code-scope.js             # Token-budget calculation for prompt sizing
├── src/lib/config/scheduled-config.js # Scheduled-task config loader (.zai-scheduled.yml)
├── src/lib/handlers/                 # Command + scheduled handlers (ask/review/explain/describe/impact/help/scheduled)
├── tests/                            # Unit and integration coverage
├── dist/index.js                     # Generated ncc bundle executed by GitHub
├── dist/licenses.txt                 # Generated third-party licenses
├── action.yml                        # Action inputs (incl. ZAI_SCHEDULED_*, ZAI_AGENTS_GIST_URL)
├── .zai-scheduled.yml                # Scheduled-task config for THIS repo (AGENTS.md upkeep)
├── .zai-scheduled.yml.template       # Consumer template for scheduled tasks
├── .github/workflows/ci.yml          # Test/build/dist-drift/audit gates
├── .github/workflows/zai-agents-update.yml  # Self-hosted scheduled AGENTS.md upkeep workflow
└── .github/workflows/code-review.yml # Consumer usage example
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Route events and command execution | `src/index.js` | `run()`, pull_request path, issue_comment command path, schedule path |
| Schedule event detection | `src/lib/events.js` | `getEventType` returns `schedule`; `shouldProcessEvent` always processes cron events |
| Parse commands and enforce allowlist | `src/lib/commands.js` | `/zai` parser, command normalization, help fallback; `update-agents` in allowlist |
| Authorization and fork policy | `src/lib/auth.js` | Collaborator checks and fork-safe behavior |
| Comment/reaction behavior | `src/lib/comments.js` | Marker-based upsert, threaded reply (`replyToId`), reactions |
| API retry/error handling | `src/lib/api.js`, `src/lib/logging.js` | Retry policy, categorized safe errors |
| Large PR batching and synthesis | `src/lib/auto-review.js` | Batch creation, context limit handling, synthesis prompt |
| Paginated changed-files fetch | `src/lib/changed-files.js` | Handles GitHub's 3000 file API limit |
| Shared PR context fetch | `src/lib/pr-context.js` | `fetchPrFiles`, `fetchFileAtRef`, `resolvePrRefs`; user-safe fallbacks, size limits |
| Scheduled-task config loading | `src/lib/config/scheduled-config.js` | `loadScheduledConfig`, `getTasksToRun`, `validateAndNormalizeConfig`, `getGistUrl` |
| Scheduled-task execution | `src/lib/handlers/scheduled.js` | `handleScheduledEvent`, `handleUpdateAgentsTask`, `SCHEDULED_HANDLERS`; see child `src/lib/handlers/AGENTS.md` |
| Manual `/zai update-agents` | `src/index.js` (`dispatchCommand`) | Reuses `handleUpdateAgentsTask` for ad-hoc AGENTS.md updates |
| Command-specific behavior | `src/lib/handlers/AGENTS.md` | Local guide for each handler module |
| Test strategy and fixtures | `tests/AGENTS.md` | Test map and suite conventions |
| Action runtime contract | `action.yml` | Node runtime + dist entrypoint |
| Build and drift policy | `package.json`, `.github/workflows/ci.yml` | `ncc` build and `dist/` drift gate |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `run` | function | `src/index.js` | high | Top-level event gate + dispatcher |
| `handlePullRequestEvent` | function | `src/index.js` | medium | PR auto-review flow |
| `handleIssueCommentEvent` | function | `src/index.js` | high | Command parse/auth/progress/dispatch flow |
| `handlePullRequestReviewCommentEvent` | function | `src/index.js` | high | Inline review comment command flow |
| `dispatchCommand` | function | `src/index.js` | high | Handler selection and response management |
| `enforceCommandAuthorization` | function | `src/index.js` | medium | Auth gate before command dispatch |
| `parseCommand` | function | `src/lib/commands.js` | high | Command extraction and validation |
| `checkForkAuthorization` | function | `src/lib/auth.js` | medium | Fork-aware security policy |
| `buildHandlerContext` | function | `src/lib/context.js` | medium | Shared context for handlers |
| `upsertComment` | function | `src/lib/comments.js` | high | Marker idempotency + threaded reply support |
| `callWithRetry` | function | `src/lib/api.js` | medium | API retry/backoff wrapper |
| `saveContinuityState` | function | `src/lib/continuity.js` | medium | Hidden state persistence across turns |
| `createReviewBatches` | function | `src/lib/auto-review.js` | medium | Large PR file chunking |
| `fetchAllChangedFiles` | function | `src/lib/changed-files.js` | medium | Paginated file list (3000 limit) |
| `fetchPrFiles` | function | `src/lib/pr-context.js` | medium | PR file list with size limits + fallbacks |
| `fetchFileAtRef` | function | `src/lib/pr-context.js` | medium | File content at base/head ref, sliding-window scoping |
| `resolvePrRefs` | function | `src/lib/pr-context.js` | low | Resolves base/head refs for diff context |
| `MAX_PR_FILES_API_LIMIT` | constant | `src/lib/changed-files.js` | low | GitHub API ceiling (3000) |
| `calculateTokenBudget` | function | `src/lib/code-scope.js` | medium | Token/char budget sizing for prompts |
| `getEventType` | function | `src/lib/events.js` | low | Event-type detection for routing (incl. `schedule`) |
| `shouldProcessEvent` | function | `src/lib/events.js` | low | Event filter; always-process gate for cron events |
| `loadScheduledConfig` | function | `src/lib/config/scheduled-config.js` | low | Parses `.zai-scheduled.yml` task config |
| `validateAndNormalizeConfig` | function | `src/lib/config/scheduled-config.js` | low | Schema validation + default-merging for tasks |
| `getTasksToRun` | function | `src/lib/config/scheduled-config.js` | low | Filters tasks whose schedule matches the event |
| `getGistUrl` | function | `src/lib/config/scheduled-config.js` | low | Resolves gist URL priority: task > defaults > env |
| `handleScheduledEvent` | function | `src/lib/handlers/scheduled.js` | medium | Scheduled pipeline entry: load config, run matching tasks |
| `executeScheduledTask` | function | `src/lib/handlers/scheduled.js` | medium | Per-task executor; builds context, dispatches via registry |
| `handleUpdateAgentsTask` | function | `src/lib/handlers/scheduled.js` | medium | AGENTS.md regeneration: gist → Z.ai → JSON diff → PR |
| `SCHEDULED_HANDLERS` | constant | `src/lib/handlers/scheduled.js` | low | Command→handler registry; `getScheduledHandler`/`registerScheduledHandler` extend it |
| `parseFileUpdatesFromResponse` | function | `src/lib/handlers/scheduled.js` | low | Multi-format JSON extraction from Z.ai output |
| `callZaiApiWithRetry` | function | `src/lib/handlers/scheduled.js` | low | Z.ai HTTP client (native https) with retry for scheduled tasks |
| `fetchFromUrl` | function | `src/lib/handlers/scheduled.js` | low | HTTP GET for gist command text (30s timeout) |
| `createPR` | function | `src/lib/handlers/scheduled.js` | low | Branch + multi-file commit + PR open for scheduled changes |

## CONVENTIONS
- Edit maintained code in `src/`; do not hand-edit generated `dist/index.js`.
- After source changes, run `npm run build` and commit `dist/index.js` + `dist/licenses.txt`.
- Use marker-based idempotent comments; preserve marker constants and update semantics.
- Command responses should stay threaded to the invoking comment via `replyToId`.
- Keep security posture strict: collaborator/fork checks before command execution, no secret leakage.

## ANTI-PATTERNS (THIS PROJECT)
- Bypassing authorization/fork checks for command handlers.
- Executing command logic for non-PR issue comments.
- Allowing unbounded context payloads into prompts.
- Editing `dist/` manually or shipping source changes without rebuilt artifacts.
- Treating `.github/workflows/code-review.yml` example as runtime logic.

## UNIQUE STYLES
- Event-first architecture: `src/index.js` orchestrates; `src/lib/*` isolates concerns.
- Reactions communicate command lifecycle (`eyes`/`thinking`/`rocket`/`x`).
- Continuity is encoded with hidden markers in comments, not external storage.

## COMMANDS
```bash
npm install
npm test            # vitest run --coverage
npm run build       # ncc build src/index.js -o dist --license licenses.txt
npm audit --audit-level=moderate   # security audit gate (CI)
```
After source changes: run `npm run build` and commit `dist/index.js` + `dist/licenses.txt` (CI fails on dist drift).

## NOTES
- CI (`.github/workflows/ci.yml`) enforces tests, build, dist drift, and security audit across Node 20 + 22.
- No linting/formatting configs (ESLint, Prettier) — rely on code review and CI gates.
- 7 command handlers + scheduled pipeline: ask (521), review (218), explain (355), describe (129), impact (336), help (95), scheduled (1081 — largest handler, drives scheduled tasks via `.zai-scheduled.yml`). `update-agents` (manual `/zai` command) reuses `handleUpdateAgentsTask` from the scheduled module.
- Scheduled pipeline gaps (per `plans/*`): no scheduled unit/integration tests yet; `docs/scheduled-tasks.md` not created; README has no scheduled section.
- Test framework: Vitest v3 (not Jest). Command: `npm test` → `vitest run --coverage`.
- Large files: src/lib/handlers/scheduled.js (1081 lines), src/index.js (1095 lines), src/lib/handlers/ask.js (521 lines), src/lib/pr-context.js (433 lines).
