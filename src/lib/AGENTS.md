# AGENTS.md

## Scope and inheritance

Applies to: `src/lib/` and descendants.

Inherits repository-wide guidance from `AGENTS.md` (root).

This file defines only local differences for the services layer.

## What lives here

```text
src/lib/
├── events.js                  # Event-type detection incl. `schedule` routing
├── commands.js                # `/zai` parser + `ALLOWED_COMMANDS` allowlist
├── auth.js                    # Collaborator/fork authorization (currently permissive)
├── context.js                 # Changed-file fetch + truncation/range helpers
├── pr-context.js              # PR files, file-at-ref, base/head ref resolution
├── changed-files.js           # Paginated changed-files fetch (3000-file ceiling)
├── comments.js                # Marker upsert + threaded replies + reactions
├── api.js                     # Z.ai HTTP client + retry wrapper
├── logging.js                 # Categorized safe errors / logger wrappers
├── continuity.js              # Hidden-marker state persistence across turns
├── code-scope.js              # Token/character budgeting for prompts
├── auto-review.js             # Large-PR batching + synthesis
├── repository-context.js      # Repo-context collection for AGENTS.md generation
├── agents-validation.js       # Hallucination guard for generated AGENTS.md
├── config/scheduled-config.js # `.zai-scheduled.yml` loader + scoping validation
└── handlers/                  # Per-command modules (see child AGENTS.md)
```

## Local boundaries and invariants

- This layer is **policy-centric and command-agnostic**. Orchestration stays in `src/index.js`; command-specific logic goes in `src/lib/handlers/`.
- External I/O is centralized here: Z.ai via `api.js`, GitHub via `pr-context.js` / `changed-files.js`. Handlers must not call Octokit ad hoc.
- Return explicit `{ success, error }`-style outcomes where already established (e.g., `api.js` `callWithRetry`, `agents-validation.js` `validateGeneratedAgentFiles`).
- Marker constants drive all automated-comment idempotency; never invent new markers without updating `comments.js` upsert semantics.
- Never leak raw exception details or secrets through this layer; route failures through `logging.js` categorization.
- Keep sizing helpers deterministic — `code-scope.js` and `context.js` budgets affect every handler and the auto-review path.

## Safe change rules

- **Adding a `/zai` command**: extend `ALLOWED_COMMANDS` + `COMMAND_DESCRIPTIONS` in `commands.js`, then add the handler in `src/lib/handlers/`, register it in `src/lib/handlers/index.js`, and wire the dispatch switch in `src/index.js`.
- **Changing event routing**: edit `events.js` (`getEventType`, `shouldProcessEvent`); cron events always pass `shouldProcessEvent`.
- **Tuning prompt budgets**: edit `code-scope.js` / `context.js`; keep sizing deterministic.
- **Adjusting retry/failure policy**: edit `api.js`; preserve `categorizeError` retry classification and progressive-timeout multipliers.
- **Changing comment lifecycle**: edit `comments.js`; preserve marker idempotency and `replyToId` threading.
- **Adjusting authorization**: edit `auth.js`; the current policy is intentionally permissive (`checkAuthorization` authorizes any identifiable user) — see root gotchas before tightening.
- **Scheduled-task config**: edit `config/scheduled-config.js`; preserve `getGistUrl` priority order (task → defaults → `ZAI_AGENTS_GIST_URL` env) and `validateAgentsConfig` scoping fields.

## Validation

- `npm test` runs the Vitest v3 suite.
- Service-specific unit tests live in `tests/`:
  - `tests/api.test.js`, `tests/auth.test.js`, `tests/comments.test.js`, `tests/commands.test.js`, `tests/context.test.js`, `tests/logging.test.js`, `tests/continuity.test.js`, `tests/events.test.js`, `tests/changed-files.test.js`, `tests/auto-review.test.js`, `tests/pr-context.test.js`.
  - `tests/lib/code-scope.test.js`.
  - `tests/scheduled-config.test.js`, `tests/repository-context.test.js`, `tests/agents-validation.test.js`.

## Nearby docs

- `src/lib/handlers/AGENTS.md` — per-command handler guide (including the structurally distinct `scheduled.js` module).
- `ARCHITECTURE.md` — full layer map, dependency direction, and request-flow diagrams.
- `SECURITY.md` — authorization model and fork-policy intent.
- `docs/scheduled-tasks.md` — scheduled-task configuration reference.
