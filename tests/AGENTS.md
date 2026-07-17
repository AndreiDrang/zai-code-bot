# AGENTS.md — tests

## Scope and inheritance

Applies to: `tests/` and its descendants (including `tests/integration/`).

Inherits from the root `AGENTS.md`. This file defines only local differences for the test suite.

Local overrides: none.

## What lives here

```text
tests/
├── *.test.js                 # Module-level unit tests
├── handlers/                 # ask / explain / impact / review / scheduled
├── helpers/mocks.js          # Shared mocks and fixture utilities
├── lib/code-scope.test.js    # Window / target block / enclosing block extraction
├── fixtures/                 # Static payloads: issue-comment-event.json, pr-event.json
└── integration/              # End-to-end pipelines + fixtures/events.js (see child AGENTS.md)
```

## Test map

| Area | File(s) | Notes |
|------|---------|-------|
| Parser / allowlist | `tests/commands.test.js` | `/zai` grammar, `update-agents` allowlisted |
| Auth / fork policy | `tests/auth.test.js` | Collaborator + fork paths; currently permissive |
| Comments / reactions | `tests/comments.test.js` | Marker idempotency, threaded replies |
| Runtime orchestration | `tests/action.test.js`, `tests/handlers.test.js`, `tests/index.test.js` | Event routing + dispatch |
| API / logging resilience | `tests/api.test.js`, `tests/logging.test.js` | Retry, backoff, error categorization |
| Context, PR fetch, batching | `tests/context.test.js`, `tests/pr-context.test.js`, `tests/changed-files.test.js`, `tests/auto-review.test.js` | Diff scoping, file-at-ref, paginated/batched review |
| Continuity / events | `tests/continuity.test.js`, `tests/events.test.js` | Hidden-marker state; event-type detection incl. `schedule` |
| Code scope | `tests/lib/code-scope.test.js` | Window, enclosing block, target extraction |
| Describe | `tests/describe.test.js` | PR description generation (not under `handlers/`) |
| Scheduled pipeline | `tests/handlers/scheduled.test.js`, `tests/scheduled-config.test.js`, `tests/repository-context.test.js`, `tests/agents-validation.test.js` | Config + scoping; grounded `handleUpdateAgentsTask`; repo-context collection; validation guards incl. PR #15 regression |
| Handler units | `tests/handlers/{ask,explain,impact,review,scheduled}.test.js` | Per-handler behavior |

## Local conventions

- Framework: Vitest v3 with globals (`describe`/`test`/`expect`); configured via `vitest.config.js`.
- Run: `npm test` → `vitest run --coverage`. Coverage is uploaded to Codecov.
- Keep tests deterministic: explicit mock payloads and marker assertions.
- Prefer scenario names that encode trigger + expected visible outcome.
- Reuse `tests/helpers/mocks.js` and `tests/fixtures/*` instead of duplicating large payloads inline.
- When changing comment markers, command UX, or output contracts, update both unit and integration assertions immediately.

## Anti-patterns

- Deleting integration assertions to make behavior changes pass.
- Asserting only internal calls without validating user-visible output.
- Duplicating large event payloads inline when fixtures already exist.
- Coupling tests to unrelated implementation details that break harmless refactors.

## Nearby docs

- Integration-specific conventions → `tests/integration/AGENTS.md`
- Handler rules → `src/lib/handlers/AGENTS.md`
