# AGENTS.md — Handler Layer

## Scope and inheritance

Applies to: `src/lib/handlers/`.
Inherits repository-wide guidance from `AGENTS.md` (root) and service-layer guidance from `src/lib/AGENTS.md`.
This file defines only local differences for this subtree.

## What lives here

```text
src/lib/handlers/
├── ask.js          # /zai ask — uses continuity state + broad PR context
├── review.js       # /zai review [file] — targeted diff review, file-in-PR validation
├── explain.js      # /zai explain <path>#Lx-Ly — range parsing + snippet extraction
├── describe.js     # /zai describe — PR description from commits
├── impact.js       # /zai impact — change impact analysis
├── help.js         # /zai help — static help output
├── scheduled.js    # Largest module: cron-driven AGENTS.md regeneration + manual /zai update-agents
└── index.js        # Handler registry/dispatcher map consumed by runtime
```

## Local boundaries and invariants

- Handlers run **only after** `enforceCommandAuthorization` succeeds in `src/index.js`.
- Handlers receive shared context (files, refs, octokit, core) — they do not construct Octokit directly.
- `scheduled.js` is distinct: it executes `.zai-scheduled.yml` tasks, not standard review commands. It is exported but is **not** in the `/zai` HANDLERS map.
- `/zai update-agents` (manual) reuses `handleUpdateAgentsTask` from `scheduled.js`.

## Scheduled module (`scheduled.js`) key flow

`handleScheduledEvent` → `executeScheduledTask` → `handleUpdateAgentsTask`:
1. Fetch command text from Gist URL (`fetchFromUrl`, 30s timeout)
2. Collect real repo context (`collectRepositoryContext`: git tree + existing AGENTS.md + key files)
3. Build grounded prompt (`buildAgentsUpgradePrompt`: embeds context, tells model NO live repo access)
4. Call Z.ai (`callZaiApiWithRetry`: native https)
5. Parse file updates (`parseFileUpdatesFromResponse`: multi-format JSON extraction)
6. Validate (`validateGeneratedAgentFiles`: rejects non-AGENTS paths, out-of-scope writes, hallucinated content)
7. Create PR (`createPR`: branch + multi-file commit + PR open) — only when at least one file changed

Registry: `SCHEDULED_HANDLERS` (const) + `registerScheduledHandler` / `getAllScheduledHandlers`.

Config consumed from `src/lib/config/scheduled-config.js` (`loadScheduledConfig`, `getTasksToRun`, `getGistUrl`, `validateAgentsConfig`).

Scoping config (all optional, per-task in `.zai-scheduled.yml`): `context_paths`, `target_paths`, `exclude_paths`, `max_context_chars`, `max_file_chars`, `max_files_to_fetch`, `allow_create_new`, `update_existing_only`.

Test seam: `handleUpdateAgentsTask` exposes `__callZaiForTest` for mocking Z.ai responses in unit tests.

## Safe change rules

- Keep command argument parsing explicit; reject invalid formats early.
- Always use threaded replies (`replyToId`) for command results.
- Reactions reflect lifecycle: acknowledge (`eyes`) → work (`eyes`) → success (`rocket`) / failure (`-1`).
- Keep prompts bounded via context truncation; never pass raw unbounded patches.
- Return user-safe failures; log internal details through `src/lib/logging.js`.
- When changing parsing or output contracts, update both unit and integration tests.

## Anti-patterns

- Parsing arguments with loose heuristics that silently alter user intent.
- Posting top-level comments for command replies (breaks conversational threading).
- Bypassing `auth.checkForkAuthorization` in a handler.
- Embedding duplicate parser/auth logic that already exists upstream.

## Validation

```bash
npm test    # vitest run --coverage
```

Key test files: `tests/handlers/ask.test.js`, `tests/handlers/explain.test.js`, `tests/handlers/impact.test.js`, `tests/handlers/review.test.js`, `tests/handlers/scheduled.test.js`, `tests/describe.test.js`, `tests/scheduled-config.test.js`, `tests/repository-context.test.js`, `tests/agents-validation.test.js`, `tests/integration/command-pipeline.test.js`.

## Nearby docs

- Scheduled-tasks configuration reference → `docs/scheduled-tasks.md`
- Service-layer module guide → `src/lib/AGENTS.md`
- Architecture and request flows → `ARCHITECTURE.md`
