# AGENTS.md — Test Suite

## Scope and inheritance

Applies to: `tests/`.
Inherits repository-wide guidance from `AGENTS.md` (root).
This file defines only local differences for this subtree.

## What lives here

```text
tests/
├── *.test.js               # Module-level tests for src/lib/* and src/index.js
├── handlers/               # Handler-focused tests (ask, explain, impact, review, scheduled)
├── helpers/                # Shared mocks and fixture utilities (mocks.js)
├── lib/                    # code-scope tests
├── fixtures/               # Static payloads (issue-comment-event.json, pr-event.json)
└── integration/            # End-to-end pipeline tests (see integration/AGENTS.md)
```

## Local boundaries and invariants

- Framework: Vitest v3 with globals (`describe` / `test` / `expect`); configured via `vitest.config.js`.
- Tests are deterministic: explicit mock payloads and marker assertions.
- Coverage uploaded to Codecov.
- Integration tests are the safety net for command threading and marker idempotency.

## Test map

| Area | Files |
|------|-------|
| Parser / commands | `tests/commands.test.js` |
| Authorization / fork policy | `tests/auth.test.js` |
| Comments / markers | `tests/comments.test.js` |
| API retry / error categorization | `tests/api.test.js` |
| Logging | `tests/logging.test.js` |
| Runtime orchestration | `tests/action.test.js`, `tests/index.test.js`, `tests/handlers.test.js` |
| Context / PR fetch / batching | `tests/context.test.js`, `tests/pr-context.test.js`, `tests/changed-files.test.js`, `tests/auto-review.test.js` |
| Continuity / events | `tests/continuity.test.js`, `tests/events.test.js` |
| Code scope / window extraction | `tests/lib/code-scope.test.js` |
| Describe handler | `tests/describe.test.js` |
| Scheduled pipeline | `tests/handlers/scheduled.test.js`, `tests/scheduled-config.test.js`, `tests/repository-context.test.js`, `tests/agents-validation.test.js` |
| Integration (e2e) | `tests/integration/command-pipeline.test.js`, `tests/integration/pr-auto-review.test.js` |

**Scheduled integration gap:** End-to-end schedule event → context → Z.ai mock → validated PR is still a gap; unit coverage of the grounded flow exists via the `handleUpdateAgentsTask` seam (`__callZaiForTest`).

## Safe change rules

- When changing comment markers or command UX, update integration assertions immediately.
- Prefer scenario names that encode trigger + expected visible outcome.
- Keep tests deterministic with explicit mock payloads and marker assertions.
- Do not duplicate large fixtures inline when reusable fixtures already exist in `tests/fixtures/`.

## Anti-patterns

- Deleting integration assertions to make behavior changes pass.
- Asserting only internal calls without validating user-visible output.
- Duplicating large fixtures inline when reusable fixtures already exist.

## Validation

```bash
npm test    # vitest run --coverage
```

## Nearby docs

- Integration test guide → `tests/integration/AGENTS.md`
- Vitest config → `vitest.config.js`
