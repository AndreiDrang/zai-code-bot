# PROJECT KNOWLEDGE BASE

**Generated:** 2025-01-20T00:00:00Z
**Branch:** main
**Refresh:** reconciled against actual file tree and source code. Verified: all `src/lib/` modules present in tree including `agents-validation.js`, `repository-context.js`; auth module (`src/lib/auth.js`) currently uses a permissive policy (authorizes any identifiable user); API client uses native `https` with progressive timeout and exponential backoff; scheduled pipeline validated against `handlers/scheduled.js` exports; comment markers defined in `src/index.js`; REACTIONS map verified in `src/lib/comments.js`.

## OVERVIEW
JavaScript GitHub Action with three event flows: (1) PR auto-review, (2) collaborator-gated `/zai` PR comment commands, and (3) cron-triggered scheduled tasks (`.zai-scheduled.yml`) that regenerate AGENTS.md files and open PRs. Runtime executes bundled `dist/index.js`; maintained logic lives in `src/index.js` plus modular services in `src/lib/*`.

## STRUCTURE
```text
zai-code-bot/
├── src/index.js                      # Runtime orchestration and event dispatch
├── src/lib/                          # Commands/auth/context/comments/api/services
├── src/lib/events.js                 # Event-type detection incl. `schedule` (cron) routing
├── src/lib/commands.js               # `/zai` parser + allowlist (incl. `update-agents`)
├── src/lib/auth.js                   # Authorization (currently permissive: any identifiable user)
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
| Parse commands and enforce allowlist | `src/lib/commands.js` | `/zai` parser, `@zai-bot`/`@zai` prefix normalization, help fallback; `update-agents` in allowlist |
| Authorization and fork policy | `src/lib/auth.js` | Currently permissive: authorizes any identifiable user; `checkForkAuthorization` silently blocks only unidentified users on fork PRs |
| Comment/reaction behavior | `src/lib/comments.js` | Marker-based upsert, threaded reply (`replyToId`), reactions (`REACTIONS` map) |
| API retry/error handling | `src/lib/api.js`, `src/lib/logging.js` | `createApiClient` with progressive timeout, exponential backoff, fallback prompts; `callWithRetry` |
| Large PR batching and synthesis | `src/lib/auto-review.js` | `createReviewBatches`, batch creation, context limit handling, synthesis prompt |
| Paginated changed-files fetch | `src/lib/changed-files.js` | `fetchAllChangedFiles` returns `{ files, pageCount, limitReached }`; 3000 file API limit |
| Shared PR context fetch | `src/lib/pr-context.js` | `fetchPrFiles`, `fetchFileAtRef`, `resolvePrRefs`; user-safe fallbacks, size limits |
| Token budget calculation | `src/lib/code-scope.js` | `extractWindow` (15-line default), `extractEnclosingBlock`, `extractTargetBlock` |
| Scheduled-task config loading | `src/lib/config/scheduled-config.js` | `loadScheduledConfig`, `getTasksToRun`, `validateAndNormalizeConfig`, `validateAgentsConfig`, `getGistUrl`; scoping fields |
| Scheduled-task execution | `src/lib/handlers/scheduled.js` | `handleScheduledEvent`, `handleUpdateAgentsTask` (grounded flow: context→prompt→validate→PR), `SCHEDULED_HANDLERS` |
| Repository context for AGENTS.md gen | `src/lib/repository-context.js` | `collectRepositoryContext` (git tree + existing AGENTS.md discovery + key files, budgeted), `renderRepositoryContext` |
| AGENTS.md output validation | `src/lib/agents-validation.js` | `validateGeneratedAgentFiles` — rejects non-AGENTS paths, out-of-scope writes, and hallucinated content |
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
| `callZaiApi` | function | `src/index.js` | medium | Direct Z.ai HTTP call (native `node:https`) for auto-review |
| `buildPrompt` | function | `src/index.js` | low | Auto-review prompt builder (non-batched) |
| `getReviewConfig` | function | `src/index.js` | low | Reads auto-review input thresholds from action inputs |
| `executeReviewBatch` | function | `src/index.js` | medium | Single-batch review with context-limit sub-splitting |
| `runLargePrReview` | function | `src/index.js` | medium | Batched review loop + synthesis |
| `parseCommand` | function | `src/lib/commands.js` | high | Command extraction and validation |
| `normalizeInput` | function | `src/lib/commands.js` | medium | `@zai-bot`/`@zai` → `/zai` prefix normalization |
| `checkForkAuthorization` | function | `src/lib/auth.js` | medium | Fork-aware authorization (currently permissive) |
| `getCommenter` | function | `src/lib/auth.js` | low | Extracts commenter from payload |
| `upsertComment` | function | `src/lib/comments.js` | high | Marker idempotency + threaded reply support |
| `REACTIONS` | constant | `src/lib/comments.js` | low | `EYES`/`THINKING`→`'eyes'`, `ROCKET`→`'rocket'`, `X`→`'-1'` |
| `createApiClient` | function | `src/lib/api.js` | medium | API client factory with timeout/retry/fallback config |
| `callWithRetry` | function | `src/lib/api.js` | medium | Exponential backoff + progressive timeout + fallback prompt |
| `categorizeError` | function | `src/lib/api.js` | low | Error classification: auth/validation/provider/rate-limit/timeout/internal |
| `saveContinuityState` | function | `src/lib/continuity.js` | medium | Hidden state persistence across turns |
| `createReviewBatches` | function | `src/lib/auto-review.js` | medium | Large PR file chunking |
| `buildSynthesisPrompt` | function | `src/lib/auto-review.js` | low | Final synthesis prompt for batched reviews |
| `isLargePr` | function | `src/lib/auto-review.js` | low | Threshold check for batched mode |
| `isContextLimitError` | function | `src/lib/auto-review.js` | low | Detects 413/context-length API errors |
| `fetchAllChangedFiles` | function | `src/lib/changed-files.js` | medium | Paginated file list (3000 limit) |
| `MAX_PR_FILES_API_LIMIT` | constant | `src/lib/changed-files.js` | low | GitHub API ceiling (3000) |
| `fetchPrFiles` | function | `src/lib/pr-context.js` | medium | PR file list with size limits + fallbacks |
| `fetchFileAtRef` | function | `src/lib/pr-context.js` | medium | File content at base/head ref, sliding-window scoping |
| `resolvePrRefs` | function | `src/lib/pr-context.js` | low | Resolves base/head refs for diff context |
| `extractWindow` | function | `src/lib/code-scope.js` | medium | Target + surrounding window extraction (15-line default) |
| `extractEnclosingBlock` | function | `src/lib/code-scope.js` | medium | Nearest function/class block detection |
| `extractTargetBlock` | function | `src/lib/code-scope.js` | low | Exact line range extraction |
| `getEventType` | function | `src/lib/events.js` | low | Event-type detection for routing (incl. `schedule`) |
| `shouldProcessEvent` | function | `src/lib/events.js` | low | Event filter; always-process gate for cron events |
| `loadScheduledConfig` | function | `src/lib/config/scheduled-config.js` | low | Parses `.zai-scheduled.yml` task config |
| `validateAndNormalizeConfig` | function | `src/lib/config/scheduled-config.js` | low | Schema validation + default-merging for tasks |
| `getTasksToRun` | function | `src/lib/config/scheduled-config.js` | low | Filters tasks whose schedule matches the event |
| `getGistUrl` | function | `src/lib/config/scheduled-config.js` | low | Resolves gist URL priority: task > defaults > env |
| `handleScheduledEvent` | function | `src/lib/handlers/scheduled.js` | medium | Scheduled pipeline entry: load config, run matching tasks |
| `handleUpdateAgentsTask` | function | `src/lib/handlers/scheduled.js` | medium | AGENTS.md regeneration: gist → collect repo context → grounded Z.ai prompt → validate → JSON diff → PR |
| `SCHEDULED_HANDLERS` | constant | `src/lib/handlers/scheduled.js` | low | Command→handler registry |
| `collectRepositoryContext` | function | `src/lib/repository-context.js` | medium | git.getTree → existing AGENTS.md discovery + key-file contents, budgeted |
| `renderRepositoryContext` | function | `src/lib/repository-context.js` | low | Renders collected context into a compact prompt block |
| `validateGeneratedAgentFiles` | function | `src/lib/agents-validation.js` | medium | Pre-PR guard: rejects non-AGENTS paths, out-of-scope writes, hallucinated content |
| `validateFileEntry` | function | `src/lib/agents-validation.js` | low | Per-file validation with structured reasons |

## CONVENTIONS
- Edit maintained code in `src/`; do not hand-edit generated `dist/index.js`.
- After source changes, run `npm run build` and commit `dist/index.js` + `dist/licenses.txt`.
- Use marker-based idempotent comments; preserve marker constants (`<!-- zai-code-review -->`, `<!-- zai-progress -->`, `<!-- zai-guidance -->`, `<!-- zai-auth -->`) and update semantics.
- Command responses should stay threaded to the invoking comment via `replyToId`.
- Reactions indicate lifecycle: `eyes` (acknowledge) → `eyes` (thinking) → `rocket` (success) / `-1` (failure).
- Authorization is currently permissive (any identifiable user is authorized); fork PRs from unidentified users are silently blocked.
- Keep prompts bounded via context truncation helpers; never pass raw unbounded patches.
- Return user-safe failure messages; log internal details through `src/lib/logging.js`.
- External I/O (Z.ai, GitHub) should flow through `src/lib/api.js` and `src/lib/pr-context.js`, not ad-hoc calls in handlers.
- `@zai-bot` and `@zai` prefixes are normalized to `/zai` before command parsing.

## ANTI-PATTERNS
- Running handler logic before auth/fork checks.
- Returning raw exception details to PR comments.
- Unbounded diff/context payloads in prompts.
- Hand-editing `dist/index.js` instead of rebuilding from `src/`.
- Introducing cross-layer coupling (handlers calling Octokit directly instead of through shared context).
- Bypassing `validateGeneratedAgentFiles` before creating a PR from scheduled task output.

## GOTCHAS
- `src/index.js` uses `require('node:https')` for its direct `callZaiApi`, while `src/lib/api.js` uses `require('https')` — both are native Node HTTPS modules but the import style differs.
- `REACTIONS.THINKING` maps to `'eyes'`, not a distinct reaction — GitHub does not support a "thinking" reaction type.
- The `dist/` drift CI gate will fail if `dist/index.js` is not rebuilt after `src/` changes.
- `MAX_PR_FILES_API_LIMIT` (3000) is GitHub's platform ceiling, not a configurable threshold.
- The auth module (`src/lib/auth.js`) contains legacy collaborator-check code (`AUTHORIZED_PERMISSIONS`, `AUTHORIZED_ASSOCIATIONS`) that is currently bypassed by an early `return { authorized: true }` in `checkAuthorization` — these constants are defined but unused in the active code path.

## KEY DOCS
- `ARCHITECTURE.md` — layered architecture, dependency direction, invariants, life-of-request flows
- `CONTRIBUTING.md` — development setup, PR process, review checklists, release steps
- `RUNBOOK.md` — operational procedures, rollback steps
- `SECURITY.md` — authorization rules and permission model
- `docs/scheduled-tasks.md` — scheduled-tasks configuration reference
- `README.md` — user-facing inputs, commands, quickstart
- `src/lib/AGENTS.md` — services-layer module guide
- `src/lib/handlers/AGENTS.md` — per-command handler guide
- `tests/AGENTS.md` — test strategy and suite layout
- `tests/integration/AGENTS.md` — end-to-end pipeline test guide
