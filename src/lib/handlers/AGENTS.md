# HANDLER MODULE GUIDE

## OVERVIEW
Command handlers implement `/zai` behavior only after parsing + authorization; each module owns prompt construction, API call wiring, and response formatting.

## WHERE TO LOOK
| Command | File | Lines | Notes |
|---------|------|-------|-------|
| `/zai ask` | `src/lib/handlers/ask.js` | 521 | Uses continuity state and broad PR context |
| `/zai review <path>` | `src/lib/handlers/review.js` | 218 | Targeted diff review, file-in-PR validation |
| `/zai explain <path>#Lx-Ly` | `src/lib/handlers/explain.js` | 355 | Range parsing + snippet extraction |
| `/zai describe` | `src/lib/handlers/describe.js` | 129 | File/directory description |
| `/zai impact` | `src/lib/handlers/impact.js` | 336 | Change impact analysis |
| `/zai help` | `src/lib/handlers/help.js` | 95 | Static help output with auth gate |
| Handler registry | `src/lib/handlers/index.js` | - | Dispatcher map consumed by runtime |

## CONVENTIONS
- Keep command argument parsing explicit and reject invalid formats early.
- Always use threaded replies (`replyToId`) for command results.
- Reactions should reflect lifecycle: acknowledge -> work -> success/failure.
- Keep prompts bounded via context truncation helpers; never pass raw unbounded patches.
- Return user-safe failures; log internal details through shared logging helpers.

## TESTING
- Local handler unit coverage exists in this folder (`review.test.js`, `explain.test.js`).
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
