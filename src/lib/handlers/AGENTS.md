# HANDLER MODULE GUIDE

## OVERVIEW
Command handlers implement `/zai` behavior only after parsing + authorization; each module owns prompt construction, API call wiring, and response formatting. The `scheduled` handler is distinct: it executes scheduled tasks defined in `.zai-scheduled.yml` (and the manual `/zai update-agents` command) rather than responding to a standard review command.

## WHERE TO LOOK
| Command | File | Lines | Notes |
|---------|------|-------|-------|
| `/zai ask` | `src/lib/handlers/ask.js` | 521 | Uses continuity state and broad PR context |
| `/zai review <path>` | `src/lib/handlers/review.js` | 218 | Targeted diff review, file-in-PR validation |
| `/zai explain <path>#Lx-Ly` | `src/lib/handlers/explain.js` | 355 | Range parsing + snippet extraction |
| `/zai describe` | `src/lib/handlers/describe.js` | 129 | File/directory description |
| `/zai impact` | `src/lib/handlers/impact.js` | 336 | Change impact analysis |
| `/zai help` | `src/lib/handlers/help.js` | 95 | Static help output with auth gate |
| `/zai update-agents` | `src/index.js` (`dispatchCommand`) | — | Manual AGENTS.md regen; reuses `handleUpdateAgentsTask` |
| scheduled tasks | `src/lib/handlers/scheduled.js` | 1081 | Largest module; cron-driven `.zai-scheduled.yml` tasks |
| Handler registry | `src/lib/handlers/index.js` | 42 | Dispatcher map consumed by runtime (note: `scheduled` is exported but not in the `/zai` HANDLERS map) |

## SCHEDULED MODULE (`scheduled.js`) KEY SYMBOLS
- `handleScheduledEvent` (entry) → `executeScheduledTask` (per-task) → `buildExecutionContext` → `getScheduledHandler` (registry lookup).
- `handleUpdateAgentsTask`: gist command → Z.ai (`callZaiApiWithRetry`) → `parseFileUpdatesFromResponse` (multi-format JSON) → diff vs repo files → `createPR`.
- Registry: `SCHEDULED_HANDLERS` (const) + `registerScheduledHandler`/`getAllScheduledHandlers` for extension.
- GitHub helpers: `fetchFileContent`, `getFileSha`, `updateFileInRepo`; HTTP: `fetchFromUrl` (gist, 30s timeout).
- Config consumed from `src/lib/config/scheduled-config.js` (`loadScheduledConfig`, `getTasksToRun`, `getGistUrl`).

## CONVENTIONS
- Keep command argument parsing explicit and reject invalid formats early.
- Always use threaded replies (`replyToId`) for command results.
- Reactions should reflect lifecycle: acknowledge -> work -> success/failure.
- Keep prompts bounded via context truncation helpers; never pass raw unbounded patches.
- Return user-safe failures; log internal details through shared logging helpers.

## TESTING
- Local handler unit coverage exists in this folder (`review.test.js`, `explain.test.js`).
- End-to-end command pipeline behavior is validated in `tests/integration/command-pipeline.test.js`.
- **Gap:** the scheduled pipeline (`scheduled.js`, `scheduled-config.js`) has NO unit/integration tests yet — `plans/*` flag this as pending.
- When changing parsing or output contracts, update both unit and integration assertions.

## ANTI-PATTERNS
- Parsing arguments with loose heuristics that silently alter user intent.
- Posting top-level comments for command replies (breaks conversational threading).
- Bypassing `auth.checkForkAuthorization` in a handler.
- Embedding duplicate parser/auth logic that already exists upstream.

## NOTES
- Prefer adding helper functions within a handler module before introducing cross-handler coupling.
- Keep marker constants stable once tests depend on them.
