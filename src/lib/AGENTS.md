# LIBRARY MODULE GUIDE

## OVERVIEW
Core runtime services used by `src/index.js`: events, commands, auth, context, comments, API, logging, and continuity.

## STRUCTURE
```text
src/lib/
├── events.js       # Event filtering and event-type detection
├── commands.js     # `/zai` parser + allowlist normalization
├── auth.js         # Collaborator/fork authorization policy
├── context.js      # Changed-file fetch + truncation/range helpers
├── comments.js     # Marker upsert + threaded replies + reactions
├── api.js          # Z.ai HTTP client and retry wrapper
├── logging.js      # Categorized safe errors and logger wrappers
├── continuity.js   # Hidden marker state persistence
└── handlers/       # Command-specific logic (see child AGENTS)
```

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Add or change command grammar | `src/lib/commands.js` | Keep command allowlist strict |
| Adjust collaborator/fork policy | `src/lib/auth.js` | Respect silent fork-block behavior |
| Tune context budget/range rules | `src/lib/context.js` | Keep truncation deterministic |
| Change comment lifecycle | `src/lib/comments.js` | Preserve marker idempotency |
| Modify API retry/failure policy | `src/lib/api.js` | Keep safe retry classification |
| Update user-safe error mapping | `src/lib/logging.js` | Do not leak internals/secrets |

## CONVENTIONS
- Prefer pure helpers for parsing/validation and exported command-safe wrappers.
- Keep handlers decoupled from Octokit details via shared context structures.
- Return explicit `{ success, error }`-style outcomes where already established.
- Use marker constants for all automated comments to avoid duplicate spam.

## ANTI-PATTERNS
- Running handler logic before auth/fork checks.
- Returning raw exception details to PR comments.
- Unbounded diff/context payloads in prompts.
- Introducing hidden coupling between unrelated service modules.

## NOTES
- If behavior is command-specific, implement in `src/lib/handlers/*` instead of this layer.
- Keep this layer policy-centric; orchestration remains in `src/index.js`.
