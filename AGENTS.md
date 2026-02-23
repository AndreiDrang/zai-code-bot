# PROJECT KNOWLEDGE BASE

**Generated:** 2026-02-23T02:12:23Z
**Commit:** d2bc3bb
**Branch:** main

## OVERVIEW
JavaScript GitHub Action that performs PR auto-review and collaborator-gated `/zai` PR comment commands. Runtime executes bundled `dist/index.js`; maintained logic lives in `src/index.js` plus modular services in `src/lib/*`.

## STRUCTURE
```text
zai-code-bot/
├── src/index.js                      # Runtime orchestration and event dispatch
├── src/lib/                          # Commands/auth/context/comments/api/services
├── src/lib/handlers/                 # Command handlers (ask/review/explain/suggest/compare/help)
├── tests/                            # Unit and integration coverage
├── dist/index.js                     # Generated ncc bundle executed by GitHub
├── dist/licenses.txt                 # Generated third-party licenses
├── action.yml                        # Action inputs and runtime entry
├── .github/workflows/ci.yml          # Test/build/dist-drift/audit gates
└── .github/workflows/code-review.yml # Consumer usage example
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Route events and command execution | `src/index.js` | `run()`, pull_request path, issue_comment command path |
| Parse commands and enforce allowlist | `src/lib/commands.js` | `/zai` parser, command normalization, help fallback |
| Authorization and fork policy | `src/lib/auth.js` | Collaborator checks and fork-safe behavior |
| Comment/reaction behavior | `src/lib/comments.js` | Marker-based upsert, threaded reply (`replyToId`), reactions |
| API retry/error handling | `src/lib/api.js`, `src/lib/logging.js` | Retry policy, categorized safe errors |
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
| `dispatchCommand` | function | `src/index.js` | high | Handler selection and response management |
| `parseCommand` | function | `src/lib/commands.js` | high | Command extraction and validation |
| `checkForkAuthorization` | function | `src/lib/auth.js` | medium | Fork-aware security policy |
| `buildHandlerContext` | function | `src/lib/context.js` | medium | Shared context for handlers |
| `upsertComment` | function | `src/lib/comments.js` | high | Marker idempotency + threaded reply support |
| `callWithRetry` | function | `src/lib/api.js` | medium | API retry/backoff wrapper |
| `saveContinuityState` | function | `src/lib/continuity.js` | medium | Hidden state persistence across turns |

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
node --test
npm run build
```

## NOTES
- CI (`.github/workflows/ci.yml`) enforces tests, build, dist drift, and security audit.
- Repo size is moderate (~58 files) with complexity concentrated in `src/lib/handlers` and integration tests.
- `CONTRIBUTING.md` still references older single-file structure; prefer current module layout in code.
