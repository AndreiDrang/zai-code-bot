# AGENTS.md

## Scope and inheritance

Applies to: `tests/` (unit + integration test suite).

Inherits repository-wide guidance from `AGENTS.md`. This file defines only local differences for the test suite.

## What lives here

```text
tests/
├── *.test.js                 # Module-level tests for lib/runtime units
├── handlers/                 # Handler-focused tests (ask, explain, impact, review, scheduled)
├── helpers/                  # Shared mocks and fixtures utilities
├── lib/                      # Shared test helpers + code-scope tests
├── fixtures/                 # Static payloads (issue-comment-event.json, pr-event.json)
└── integration/              # End-to-end pipelines — see child AGENTS.md
```

## Local boundaries and invariants

- Framework: **Vitest v3** with globals (`describe` / `test` / `expect`); configured via `vitest.config.js`.
- Keep tests deterministic: explicit mock payloads, no real network, marker-based assertions for comment lifecycle.
- Prefer scenario names that encode trigger + expected visible outcome.
- Integration tests are the safety net for command threading and marker idempotency — do not delete their assertions to make a change pass.
- Reuse existing fixtures (`tests/fixtures/`, `tests/integration/fixtures/events.js`, `tests/helpers/mocks.js`) instead of inlining large payloads.
- Validate user-visible output, not only internal call sequences.

## Test map

| Area | File(s) |
|------|---------|
| Parser / help text | `tests/commands.test.js` |
| Auth + fork policy | `tests/auth.test.js` |
| Comment lifecycle / markers | `tests/comments.test.js` |
| Runtime dispatch | `tests/action.test.js`, `tests/handlers.test.js`, `tests/index.test.js` |
| API retry / error categorization | `tests/api.test.js` |
| Safe error mapping | `tests/logging.test.js` |
| Diff scoping / file-at-ref | `tests/context.test.js`, `tests/pr-context.test.js` |
| Paginated file fetch | `tests/changed-files.test.js` |
| Large-PR batching | `tests/auto-review.test.js` |
| Continuity state / event detection | `tests/continuity.test.js`, `tests/events.test.js` |
| Token budget / window extraction | `tests/lib/code-scope.test.js` |
| Describe handler | `tests/describe.test.js` |
| Handler units | `tests/handlers/{ask,explain,impact,review,scheduled}.test.js` |
| Scheduled config + scoping | `tests/scheduled-config.test.js` |
| Repo-context collection | `tests/repository-context.test.js` |
| AGENTS.md validation guards | `tests/agents-validation.test.js` |
| Full command pipeline | `tests/integration/command-pipeline.test.js` |
| PR auto-review pipeline | `tests/integration/pr-auto-review.test.js` |

## Validation

- Run: `npm test` → `vitest run --coverage`.
- Coverage is uploaded to Codecov.
- Known gap: end-to-end schedule event → context → Z.ai mock → validated PR is not yet an integration test; the grounded `handleUpdateAgentsTask` flow is exercised via the `__callZaiForTest` seam in `tests/handlers/scheduled.test.js`.

## Nearby docs

- Integration pipeline detail → `tests/integration/AGENTS.md`.
- Handler behavior under test → `src/lib/handlers/AGENTS.md`.
