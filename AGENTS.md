# PROJECT KNOWLEDGE BASE

**Generated:** 2025-01-20T00:00:00Z
**Branch:** main
**Refresh:** reconciled against actual file tree, source code, action.yml, and test suite. Updated auth policy descriptions to reflect current permissive implementation in `src/lib/auth.js`. Fixed CODE MAP entries: replaced nonexistent `calculateTokenBudget` with actual `extractEnclosingBlock`/`extractWindow` from `code-scope.js`; replaced `saveContinuityState` with actual `loadContinuityState`/`createCommentWithState` from `continuity.js`. Completed CONVENTIONS, ANTI-PATTERNS, and NOTES sections from observable code evidence. Verified all file paths, handler symbols, test references, and workflow filenames against repository tree.

## OVERVIEW
JavaScript GitHub Action with three event flows: (1) PR auto-review on `opened`/`synchronize`, (2) authorization-gated `/zai` PR comment commands (`ask`, `review`, `explain`, `describe`, `impact`, `update-agents`, `help`), and (3) cron-triggered scheduled tasks (`.zai-scheduled.yml`) that regenerate AGENTS.md files and open PRs. Runtime executes bundled `dist/index.js`; maintained logic lives in `src/index.js` plus modular services in `src/lib/*`.

> **Auth implementation note:** `src/lib/auth.js` currently implements a permissive policy — `checkAuthorization` and `checkForkAuthorization` return `authorized: true` for any identifiable GitHub user. Fork PR commenters without an identifiable login are silently blocked (`reason: null`). The collaborator-checking infrastructure (`isCollaborator`, `AUTHORIZED_PERMISSIONS`, `AUTHORIZED_ASSOCIATIONS`) remains exported but is not called by the main authorization path. `SECURITY.md` documents the intended collaborator-based policy.

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
├── src/lib/code-scope.js             # Window/enclosing-block extraction for prompt scoping
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
| Authorization and fork policy | `src/lib/auth.js` | Currently permissive (authorizes any identifiable user); fork PR unidentified users silently blocked. Collaborator-check infrastructure present but not exercised |
| Comment/reaction behavior | `src/lib/comments.js` | Marker-based upsert, threaded reply (`replyToId`), reactions |
| API retry/error handling | `src/lib/api.js`, `src/lib/logging.js` | Retry policy, categorized safe errors |
| Large PR batching and synthesis | `src/lib/auto-review.js` | Batch creation, context limit handling, synthesis prompt |
| Paginated changed-files fetch | `src/lib/changed-files.js` | Handles GitHub's 3000 file API limit |
| Shared PR context fetch | `src/lib/pr-context.js` | `fetchPrFiles`, `fetchFileAtRef`, `resolvePrRefs`; user-safe fallbacks, size limits |
| Prompt scoping | `src/lib/code-scope.js` | `extractWindow`, `extractEnclosingBlock`, `extractTargetBlock` |
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
| `checkForkAuthorization` | function | `src/lib/auth.js` | medium | Fork-aware auth gate (currently permissive: any identifiable user) |
| `buildHandlerContext` | function | `src/lib/context.js` | medium | Shared context for handlers |
| `upsertComment` | function | `src/lib/comments.js` | high | Marker idempotency + threaded reply support |
| `createApiClient` | function | `src/lib/api.js` | medium | Factory for API client with retry/timeout config |
| `callWithRetry` | function | `src/lib/api.js` | medium | API retry/backoff wrapper with progressive timeout |
| `loadContinuityState` | function | `src/lib/continuity.js` | medium | Hidden state loading across turns |
| `createCommentWithState` | function | `src/lib/continuity.js` | low | Comment creation with embedded continuity state |
| `createReviewBatches` | function | `src/lib/auto-review.js` | medium | Large PR file chunking |
| `fetchAllChangedFiles` | function | `src/lib/changed-files.js` | medium | Paginated file list (3000 limit) |
| `fetchPrFiles` | function | `src/lib/pr-context.js` | medium | PR file list with size limits + fallbacks |
| `fetchFileAtRef` | function | `src/lib/pr-context.js` | medium | File content at base/head ref, sliding-window scoping |
| `resolvePrRefs` | function | `src/lib/pr-context.js` | low | Resolves base/head refs for diff context |
| `MAX_PR_FILES_API_LIMIT` | constant | `src/lib/changed-files.js` | low | GitHub API ceiling (3000) |
| `extractEnclosingBlock` | function | `src/lib/code-scope.js` | medium | Enclosing function/class block detection for prompt scoping |
| `extractWindow` | function | `src/lib/code-scope.js` | low | Surrounding window extraction for prompt scoping |
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
- Use marker-based idempotent comments; preserve marker constants and update semantics.
- Command responses should stay threaded to the invoking comment via `replyToId`.
- Keep prompts bounded via `src/lib/code-scope.js` and `src/lib/context.js`; never pass raw unbounded patches.
- Route external I/O (Z.ai, GitHub) through `src/lib/api.js` and `src/lib/pr-context.js`, not ad-hoc calls in handlers.
- Return user-safe error messages; route internal details through `src/lib/logging.js`.
- All generated AGENTS.md content must pass `src/lib/agents-validation.js` before PR creation.
- The services layer (`src/lib/*.js`) stays policy-centric; command-specific logic goes in `src/lib/handlers/`.

## ANTI-PATTERNS
- Hand-editing `dist/index.js` instead of `src/` (CI `dist-drift` gate will fail).
- Running handler logic before `enforceCommandAuthorization` in `src/index.js`.
- Returning raw exception details or secrets in PR comments.
- Passing unbounded diffs/patches into prompts.
- Bypassing `src/lib/agents-validation.js` for generated AGENTS.md content.
- Introducing coupling between handlers and Octokit details directly (use shared context pattern).

## NOTES
- Test command: `npm test` → `vitest run --coverage`.
- Build command: `npm run build` → `ncc build src/index.js -o dist --license licenses.txt`.
- The runtime is event-driven (not a server); GitHub Actions runner invokes `dist/index.js` per webhook event.
- Marker constants in `src/index.js`: `<!-- zai-code-review -->`, `<!-- zai-progress -->`, `<!-- zai-guidance -->`, `<!-- zai-auth -->`.
- Z.ai API endpoint: `https://api.z.ai/api/coding/paas/v4/chat/completions`.
- Default model: `glm-5.2` (overridable via `ZAI_MODEL` input).
- `REACTIONS.THINKING` in `src/lib/comments.js` maps to `'eyes'`, not `'thinking'`; both `EYES` and `THINKING` produce the `eyes` reaction.
- Coverage uploaded to Codecov.
