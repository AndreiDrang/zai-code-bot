# PROJECT KNOWLEDGE BASE

**Generated:** 2025-01-20T00:00:00Z
**Branch:** main
**Refresh:** reconciled against actual file tree and `plans/*`; verified scheduled event routing, config loader, handler symbols, manual `/zai update-agents` command, action.yml inputs, and test coverage. Confirmed: scheduled test coverage exists (`tests/handlers/scheduled.test.js`, `tests/scheduled-config.test.js`, `tests/repository-context.test.js`, `tests/agents-validation.test.js`); `docs/scheduled-tasks.md` present; README updated with scheduled-tasks section and `/zai update-agents` command.

## OVERVIEW
JavaScript GitHub Action with three event flows: (1) PR auto-review, (2) collaborator-gated `/zai` PR comment commands, and (3) cron-triggered scheduled tasks (`.zai-scheduled.yml`) that regenerate AGENTS.md files and open PRs. Runtime executes bundled `dist/index.js`; maintained logic lives in `src/index.js` plus modular services in `src/lib/*`.

## STRUCTURE
```text
zai-code-bot/
├── src/index.js                      # Runtime orchestration and event dispatch
├── src/lib/                          # Commands/auth/context/comments/api/services
├── src/lib/events.js                 # Event-type detection incl. `schedule` (cron) routing
├── src/lib/commands.js               # `/zai` parser + allowlist (incl. `update-agents`)
├── src/lib/auto-review.js            # Large PR batching and synthesis
├── src/lib/changed-files.js          # Paginated changed-files fetch (3000 file limit)
├── src/lib/pr-context.js             # Shared PR context fetch (files, content at ref, refs)
├── src/lib/code-scope.js             # Token-budget calculation for prompt sizing
├── src/lib/context.js                # Changed-file fetch + truncation/range helpers
├── src/lib/config/scheduled-config.js # Scheduled-task config loader (.zai-scheduled.yml)
├── src/lib/repository-context.js     # Real repo context collection (tree + AGENTS.md discovery + key files)
├── src/lib/agents-validation.js      # Hallucination guard: validates generated AGENTS.md vs real repo
├── src/lib/handlers/                 # Command + scheduled handlers (ask/review/explain/describe/impact/help/scheduled)
├── tests/                            # Unit and integration coverage (Vitest v3)
├── dist/index.js                     # Generated ncc bundle executed by GitHub
├── dist/licenses.txt                 # Generated third-party licenses
├── action.yml                        # Action inputs (incl. ZAI_SCHEDULED_*, ZAI_AGENTS_GIST_URL)
├── .zai-scheduled.yml                # Scheduled-task config for THIS repo (AGENTS.md upkeep)
├── .zai-scheduled.yml.template       # Consumer template for scheduled tasks
├── .github/workflows/ci.yml                     # Test/build/dist-drift/audit gates
├── .github/workflows/zai-agents-update.yml      # Self-hosted scheduled AGENTS.md upkeep
├── .github/workflows/zai-code-bot.yml           # Bot execution on this repo's own PRs
├── .github/workflows/zai-agents-init-example.yml # Example workflow for AGENTS.md init
├── docs/scheduled-tasks.md           # Scheduled-tasks configuration reference
├── plans/                            # Planning docs (scheduled-tasks integration)
├── ARCHITECTURE.md                   # Layered architecture and invariants catalog
├── CONTRIBUTING.md                   # Contribution guide and review checklists
├── RUNBOOK.md                        # Operational runbook and rollback procedures
├── SECURITY.md                       # Security policies and authorization rules
├── README.md                         # User-facing inputs, commands, quickstart
└── vitest.config.js                  # Vitest configuration
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
| Token budget calculation | `src/lib/code-scope.js` | Window extraction, enclosing block detection for prompt sizing |
| Scheduled-task config loading | `src/lib/config/scheduled-config.js` | `loadScheduledConfig`, `getTasksToRun`, `validateAndNormalizeConfig`, `validateAgentsConfig`, `getGistUrl`; scoping fields (`context_paths`/`target_paths`/`exclude_paths`/budgets) |
| Scheduled-task execution | `src/lib/handlers/scheduled.js` | `handleScheduledEvent`, `handleUpdateAgentsTask` (grounded flow: context→prompt→validate→PR), `SCHEDULED_HANDLERS`; see child `src/lib/handlers/AGENTS.md` |
| Repository context for AGENTS.md gen | `src/lib/repository-context.js` | `collectRepositoryContext` (git tree + existing AGENTS.md discovery + key files, budgeted), `renderRepositoryContext` |
| AGENTS.md output validation | `src/lib/agents-validation.js` | `validateGeneratedAgentFiles` — rejects non-AGENTS paths, out-of-scope writes, and hallucinated content referencing non-existent files |
| Manual `/zai update-agents` | `src/index.js` (`dispatchCommand`) | Reuses `handleUpdateAgentsTask` for ad-hoc AGENTS.md updates |
| Command-specific behavior | `src/lib/handlers/AGENTS.md` | Local guide for each handler module |
| Test strategy and fixtures | `tests/AGENTS.md` | Test map and suite conventions |
| Scheduled-tasks reference | `docs/scheduled-tasks.md` | Configuration reference, cron syntax, troubleshooting |
| Architecture and invariants | `ARCHITECTURE.md` | Layered architecture, dependency direction, life-of-request flows |
| Operational procedures | `RUNBOOK.md` | Rollback and incident response |
| Security policies | `SECURITY.md` | Authorization rules and permission model |
| Action runtime contract | `action.yml` | Node 20 runtime + dist entrypoint |
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
| `handleUpdateAgentsTask` | function | `src/lib/handlers/scheduled.js` | medium | AGENTS.md regeneration: gist → collect repo context → grounded Z.ai prompt → validate → JSON diff → PR |
| `SCHEDULED_HANDLERS` | constant | `src/lib/handlers/scheduled.js` | low | Command→handler registry; `getScheduledHandler`/`registerScheduledHandler` extend it |
| `buildAgentsUpgradePrompt` | function | `src/lib/handlers/scheduled.js` | low | Grounded prompt: embeds real tree + existing AGENTS.md + key files; tells model it has NO live repo access |
| `parseFileUpdatesFromResponse` | function | `src/lib/handlers/scheduled.js` | low | Multi-format JSON extraction from Z.ai output |
| `callZaiApiWithRetry` | function | `src/lib/handlers/scheduled.js` | low | Z.ai HTTP client (native https) with retry for scheduled tasks |
| `fetchFromUrl` | function | `src/lib/handlers/scheduled.js` | low | HTTP GET for gist command text (30s timeout) |
| `createPR` | function | `src/lib/handlers/scheduled.js` | low | Branch + multi-file commit + PR open for scheduled changes |
| `collectRepositoryContext` | function | `src/lib/repository-context.js` | medium | git.getTree → existing AGENTS.md discovery + key-file contents, budgeted + glob-excluded |
| `renderRepositoryContext` | function | `src/lib/repository-context.js` | low | Renders collected context into a compact prompt block |
| `validateGeneratedAgentFiles` | function | `src/lib/agents-validation.js` | medium | Pre-PR guard: rejects non-AGENTS paths, out-of-scope/target writes, and hallucinated content |
| `validateAgentsConfig` | function | `src/lib/config/scheduled-config.js` | low | Validates scoping/budget config fields (`context_paths`, `target_paths`, etc.) |

## CONVENTIONS
- Edit maintained code in `src/`; do not hand-edit generated `dist/index.js`.
- After source changes, run `npm run build` and commit `dist/index.js` + `dist/licenses.txt`.
- Use marker-based idempotent comments; preserve marker constants (`COMMENT_MARKER`, `PROGRESS_MARKER`, `AUTH_MARKER`, `GUIDANCE_MARKER`) and update semantics.
- Command responses must stay threaded to the invoking comment via `replyToId`; never post top-level comments for command replies.
- Keep prompts bounded via `src/lib/code-scope.js` and `src/lib/context.js`; never pass raw unbounded patches into Z.ai prompts.
- Return user-safe error messages; route internal details through `src/lib/logging.js` categorized safe errors.
- Reactions (`eyes`, `thinking`, `rocket`, `x`) indicate lifecycle: acknowledge → work → success/failure.

## ANTI-PATTERNS
- Hand-editing `dist/index.js` instead of rebuilding from `src/`.
- Running command handlers before `enforceCommandAuthorization` succeeds.
- Posting unthreaded command replies (breaks conversational threading and duplicates context).
- Passing unbounded diffs or full-file dumps into Z.ai prompts.
- Surfacing raw exception internals or secrets in PR comments.
- Introducing ad-hoc GitHub/Z.ai I/O calls in handlers instead of routing through `src/lib/api.js` and `src/lib/pr-context.js`.
- Creating non-`AGENTS.md` files or out-of-scope writes in the scheduled `update-agents` task (rejected by `validateGeneratedAgentFiles`).

## NOTES
- Build: `npm run build` (ncc bundles `src/index.js` → `dist/index.js` + `dist/licenses.txt`).
- Test: `npm test` → `vitest run --coverage`.
- CI gates: test, build, dist-drift (fails on uncommitted `dist/` changes), security audit (`.github/workflows/ci.yml`).
- Action runtime: Node 20 (`action.yml` `using: "node20"`, `main: "dist/index.js"`).
- Scheduled config: `.zai-scheduled.yml` (this repo), `.zai-scheduled.yml.template` (consumer template).
- Gist URL priority for `update-agents`: task config `gist_url` > defaults `gist_url` > `ZAI_AGENTS_GIST_URL` action input.
- Default model: `glm-5.2` (overridable via `ZAI_MODEL`).
- See `ARCHITECTURE.md` for layered architecture, dependency direction, and life-of-request flows.
- See `RUNBOOK.md` for rollback and incident response.
- See `SECURITY.md` for authorization rules and the fork-PR permission model.
