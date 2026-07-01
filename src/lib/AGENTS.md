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
├── code-scope.js   # Token budget calculation for prompt sizing
├── auto-review.js  # Large PR batching and synthesis
├── changed-files.js # Paginated changed-files fetch (3000 limit)
├── pr-context.js   # Shared PR context fetch (files, content at ref, refs)
├── config/scheduled-config.js # Scheduled-task config loader (.zai-scheduled.yml)
└── handlers/       # Command-specific logic (see child AGENTS)
```

## WHERE TO LOOK
| Task | File | Notes |
|------|------|-------|
| Add or change command grammar | `src/lib/commands.js` | Keep command allowlist strict; `update-agents` is allowed |
| Event-type detection / routing | `src/lib/events.js` | `getEventType` + `shouldProcessEvent`; includes `schedule` (cron) always-process gate |
| Adjust collaborator/fork policy | `src/lib/auth.js` | Respect silent fork-block behavior |
| Tune context budget/range rules | `src/lib/context.js` | Keep truncation deterministic |
| Change comment lifecycle | `src/lib/comments.js` | Preserve marker idempotency |
| Modify API retry/failure policy | `src/lib/api.js` | Keep safe retry classification |
| Update user-safe error mapping | `src/lib/logging.js` | Do not leak internals/secrets |
| Large PR batching logic | `src/lib/auto-review.js` | Batch creation, synthesis prompts |
| Paginated file fetching | `src/lib/changed-files.js` | GitHub API 3000 file limit |
| Shared PR context fetch | `src/lib/pr-context.js` | `fetchPrFiles`, `fetchFileAtRef`, `resolvePrRefs`; user-safe fallbacks, size limits |
| Tune prompt token budget | `src/lib/code-scope.js` | Keep sizing deterministic; affects all handlers |
| Scheduled-task config parsing | `src/lib/config/scheduled-config.js` | Consumed by `handlers/scheduled.js` |

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
