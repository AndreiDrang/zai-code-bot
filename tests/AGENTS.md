# AGENTS.md

## Scope and inheritance

Applies to: `tests/`.

Inherits repository-wide guidance from `AGENTS.md`.

This file defines only local differences for the test suite.

## What lives here

```text
tests/
├── *.test.js                    # Module-level tests (commands, auth, api, context, etc.)
├── handlers/                    # Handler-focused tests (ask, explain, impact, review, scheduled)
├── helpers/mocks.js             # Shared mock utilities
├── lib/code-scope.test.js       # Token budget and window extraction tests
├── fixtures/                    # Static payloads (issue-comment-event.json, pr-event.json)
└── integration/                 # End-to-end pipeline tests (see child AGENTS.md)
```

## Test layout and coverage

| Area | Location | Notes |
|------|----------|-------|
| Parser/auth/comment units | `tests/commands.test.js`, `tests/auth.test.js`, `tests/comments.test.js` | Fast regression checks |
| Runtime orchestration | `tests/action.test.js`, `tests/handlers.test.js`, `tests/index.test.js` | Entry flow and dispatch behavior |
| API and logging resilience | `tests/api.test.js`, `tests/logging.test.js` | Retry/error categorization |
| Context, PR fetch, batching | `tests/context.test.js`, `tests/pr-context.test.js`, `tests/changed-files.test.js`, `tests/auto-review.test.js` | Diff scoping, file-at-ref, pagination, batched review |
| Continuity and events | `tests/continuity.test.js`, `tests/events.test.js` | Hidden-marker state, event-type detection |
| Code scope | `tests/lib/code-scope.test.js` | Token budget, enclosing block, window extraction |
| Describe handler | `tests/describe.test.js` | PR description generation |
| Scheduled pipeline | `tests/handlers/scheduled.test.js`, `tests/scheduled-config.test.js`, `tests/repository-context.test.js`, `tests/agents-validation.test.js` | Config, scoping, grounded flow, hallucination rejection |
| Full command pipeline | `tests/integration/command-pipeline.test.js` | Parse → auth → handler → output contract |
| PR auto-review | `tests/integration/pr-auto-review.test.js` | Marker upsert and PR event lifecycle |

Note: End-to-end scheduled event → context → Z.ai mock → validated PR integration test is still a gap; unit coverage of the grounded flow exists via the `handleUpdateAgentsTask` seam.

## Conventions

- Test framework: Vitest v3 (globals: `describe`/`test`/`expect`); configured via `vitest.config.js`.
- Test command: `npm test` → `vitest run --coverage`.
- Coverage uploaded to Codecov.
- Keep tests deterministic with explicit mock payloads and marker assertions.
- Prefer scenario names that encode trigger + expected visible outcome.
- When changing comment markers or command UX, update integration assertions immediately.

## Anti-patterns

- Deleting integration assertions to make behavior changes pass.
- Asserting only internal calls without validating user-visible output.
- Duplicating large fixtures inline when reusable fixtures already exist.
