# HANDLER MODULE GUIDE

**Scope:** `src/lib/handlers/` and descendants. Inherits repository-wide guidance from `AGENTS.md` and services-layer guidance from `src/lib/AGENTS.md`. This file defines only handler-layer detail; no local overrides.

## OVERVIEW
Command handlers implement `/zai` behavior only after parsing + authorization; each module owns prompt construction, API call wiring, and response formatting. The `scheduled` handler is distinct: it executes scheduled tasks defined in `.zai-scheduled.yml` (and the manual `/zai update-agents` command) rather than responding to a standard review command.

## WHERE TO LOOK
| Command | File | Notes |
|---------|------|-------|
| `/zai ask` | `src/lib/handlers/ask.js` | Uses continuity state and broad PR context |
| `/zai review <path>` | `src/lib/handlers/review.js` | Targeted diff review, file-in-PR validation |
| `/zai explain <path>#Lx-Ly` | `src/lib/handlers/explain.js` | Range parsing + snippet extraction |
| `/zai describe` | `src/lib/handlers/describe.js` | File/directory description |
| `/zai impact` | `src/lib/handlers/impact.js` | Change impact analysis |
| `/zai help` | `src/lib/handlers/help.js` | Static help output with auth gate |
| `/zai update-agents` | `src/index.js` (`dispatchCommand`) | Manual AGENTS.md regen; reuses `handleUpdateAgentsTask` |
| scheduled tasks | `src/lib/handlers/scheduled.js` | Largest module; cron-driven `.zai-scheduled.yml` tasks; grounded + validated AGENTS.md upgrades |
| Handler registry | `src/lib/handlers/index.js` | Dispatcher map consumed by runtime (note: `scheduled` is exported but not in the `/zai` HANDLERS map) |

## SCHEDULED MODULE (`scheduled.js`) KEY SYMBOLS
- `handleScheduledEvent` (entry) → `executeScheduledTask` (per-task) → `buildExecutionContext` → `getScheduledHandler` (registry lookup).
- `handleUpdateAgentsTask` (grounded flow): gist command → `collectRepositoryContext` (`../repository-context.js`: real tree + existing AGENTS.md discovery + key files) → `buildAgentsUpgradePrompt` (embeds context, tells model it has NO live repo access) → `callZaiApiWithRetry` → `parseFileUpdatesFromResponse` (multi-format JSON) → `validateGeneratedAgentFiles` (`../agents-validation.js`: rejects non-AGENTS paths, out-of-scope writes, hallucinated content referencing non-existent files) → diff vs repo files → `createPR`.
- Registry: `SCHEDULED_HANDLERS` (const) + `registerScheduledHandler`/`getAllScheduledHandlers` for extension.
- GitHub helpers: `fetchFileContent`, `getFileSha`, `updateFileInRepo`; HTTP: `fetchFromUrl` (gist, 30s timeout).
- Config consumed from `src/lib/config/scheduled-config.js` (`loadScheduledConfig`, `getTasksToRun`, `getGistUrl`, `validateAgentsConfig`).
- Scoping config (all optional, per-task in `.zai-scheduled.yml`): `context_paths`, `target_paths`, `exclude_paths`, `max_context_chars`, `max_file_chars`, `max_files_to_fetch`, `allow_create_new`, `update_existing_only`.

## CONVENTIONS
- Keep command argument parsing explicit and reject invalid formats early.
- Always use threaded replies (`replyToId`) for command results.
- Reactions should reflect lifecycle: acknowledge -> work -> success/failure.
- Keep prompts bounded via context truncation helpers; never pass raw unbounded patches.
- Return user-safe failures; log internal details through shared logging helpers.

## TESTING
- Local handler unit coverage exists in `tests/handlers/`: `ask.test.js`, `explain.test.js`, `impact.test.js`, `review.test.js`, `scheduled.test.js`.
- Scheduled pipeline coverage: `tests/handlers/scheduled.test.js` (registry, PR creation, parse, grounded `handleUpdateAgentsTask` flow incl. hallucination rejection), `tests/scheduled-config.test.js` (config + `validateAgentsConfig` scoping fields), `tests/repository-context.test.js` (tree/AGENTS.md discovery/budgets/globs), `tests/agents-validation.test.js` (path/hallucination/target-path guards incl. PR #15 regression).
- End-to-end command pipeline behavior is validated in `tests/integration/command-pipeline.test.js`.
- When changing parsing or output contracts, update both unit and integration assertions.

## ANTI-PATTERNS
- Parsing arguments with loose heuristics that silently alter user intent.
- Posting top-level comments for command replies (breaks conversational threading).
- Bypassing `auth.checkForkAuthorization` in a handler.
- Embedding duplicate parser/auth logic that already exists upstream.

## NOTES
- Prefer adding helper functions within a handler module before introducing cross-handler coupling.
- Keep marker constants stable once tests depend on them.
