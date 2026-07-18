# AGENTS.md

## Scope and inheritance

Applies to: `tests/` and descendants.

Inherits repository-wide guidance from `AGENTS.md` (root).

This file defines only local differences for the test suite.

## What lives here

```text
tests/
├── *.test.js                 # Module-level tests for lib/runtime units
├── handlers/                 # Handler-focused tests (ask, explain, impact, review, scheduled)
├── helpers/                  # Shared mocks and fixtures (mocks.js)
├── lib/                      # Shared test helpers + code-scope tests
├── fixtures/                 # Static event payloads (issue-comment-event.json, pr-event.json)
└── integration/              # End-to-end pipeline tests (see child AGENTS.md)
```

## Local boundaries and invariants

- Framework: **Vitest v3** with globals (`describe`, `test`, `expect`); configured via `vitest.config.js`.
- Tests run via `npm test` → `vitest run --coverage`; coverage uploads to Codecov.
- Keep tests deterministic: explicit mock payloads and explicit marker assertions.
- Prefer scenario names that encode trigger + expected visible outcome.
- Integration tests under `tests/integration/` are the safety net for command threading and marker idempotency — do not replace them with unit-level mocks only.
- Handler tests go in `tests/handlers/`, not alongside the module-level `tests/*.test.js` files.

## Test map

| Concern | File(s) |
|---|---|
| Parser / commands | `tests/commands.test.js` |
| Authorization / fork policy | `tests/auth.test.js` |
| Comment lifecycle / markers | `tests/comments.test.js` |
| Runtime orchestration | `tests/action.test.js`, `tests/handlers.test.js`, `tests/index.test.js` |
| API retry / error categorization | `tests/api.test.js`, `tests/logging.test.js` |
| Context / PR fetch / batching | `tests/context.test.js`, `tests/pr-context.test.js`, `tests/changed-files.test.js`, `tests/auto-review.test.js` |
| Continuity / events | `tests/continuity.test.js`, `tests/events.test.js` |
| Code scope / window extraction | `tests/lib/code-scope.test.js` |
| Describe handler | `tests/describe.test.js` |
| Scheduled pipeline | `tests/handlers/scheduled.test.js`, `tests/scheduled-config.test.js`, `tests/repository-context.test.js`, `tests/agents-validation.test.js` |
| Command pipeline (e2e) | `tests/integration/command-pipeline.test.js` |
| PR auto-review (e2e) | `tests/integration/pr-auto-review.test.js` |

## Safe change rules

- When changing comment markers (`<!-- zai-code-review -->`, `<!-- zai-progress -->`, `<!-- zai-guidance -->`, `<!-- zai-auth -->`), command UX, or reaction lifecycle, update integration assertions in the same change.
- Do not delete integration assertions to make behavior changes pass.
- Assert user-visible output (comment body, reaction, threading), not only internal call sequences.
- Reuse `tests/fixtures/issue-comment-event.json`, `tests/fixtures/pr-event.json`, `tests/helpers/mocks.js`, and `tests/integration/fixtures/events.js` instead of inlining large event payloads.
- When changing the scheduled handler, exercise the `__callZaiForTest` seam in `tests/handlers/scheduled.test.js` so the grounded flow (collect → prompt → validate → PR) stays covered.

## Known gaps

- End-to-end scheduled event → context → Z.ai mock → validated PR is not covered in `tests/integration/`. The grounded `handleUpdateAgentsTask` flow is unit-tested via the `__callZaiForTest` seam in `tests/handlers/scheduled.test.js`.

## Nearby docs

- `tests/integration/AGENTS.md` — end-to-end pipeline test guide.
- `CONTRIBUTING.md` — review checklists and release process.
- `ARCHITECTURE.md` — life-of-request flows that integration tests mirror.
