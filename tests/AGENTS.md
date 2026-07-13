# TEST SUITE GUIDE

## Scope and inheritance

Applies to: `tests/`.

Inherits repository-wide guidance from `AGENTS.md` (root).

This file defines only local differences for this subtree.

## OVERVIEW
Repository test coverage mixes module-focused tests in `tests/*.test.js` and scenario-driven flows in `tests/integration/*`.

## STRUCTURE
```text
tests/
├── *.test.js        # Module-level tests for lib/runtime units
├── handlers/        # Handler-focused test cases (ask, explain, impact, review, scheduled)
├── helpers/         # Shared mocks and fixtures utilities
├── lib/             # Shared test helpers + code-scope tests
├── fixtures/        # Static test payloads (issue-comment-event.json, pr-event.json)
└── integration/     # End-to-end command/review pipeline checks
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Parser/auth/comment unit behavior | `tests/commands.test.js`, `tests/auth.test.js`, `tests/comments.test.js` | Fast regression checks |
| Runtime orchestration checks | `tests/action.test.js`, `tests/handlers.test.js`, `tests/index.test.js` | Entry flow and dispatch behavior |
| API and logging resilience | `tests/api.test.js`, `tests/logging.test.js` | Retry/error categorization |
| Context, PR fetch, and batching | `tests/context.test.js`, `tests/pr-context.test.js`, `tests/changed-files.test.js`, `tests/auto-review.test.js` | Diff scoping, file-at-ref fetch, paginated/batched review |
| Continuity and events | `tests/continuity.test.js`, `tests/events.test.js` | Hidden-marker state, event-type detection |
| Code scope and window extraction | `tests/lib/code-scope.test.js` | Token budget, enclosing block, window extraction |
| Describe handler | `tests/describe.test.js` | PR description generation |
| Scheduled pipeline | `tests/handlers/scheduled.test.js`, `tests/scheduled-config.test.js`, `tests/repository-context.test.js`, `tests/agents-validation.test.js` | Config load + `validateAgentsConfig` scoping; `parseFileUpdatesFromResponse`; grounded `handleUpdateAgentsTask` flow incl. hallucination rejection; repo-context collection (tree/budgets/globs); validation guards incl. PR #15 regression |
| Scheduled pipeline (integration) | (pending) | End-to-end schedule event → context → Z.ai mock → validated PR is still a gap; unit coverage of the grounded flow exists via the `handleUpdateAgentsTask` seam (`__callZaiForTest`). |
| Full command pipeline | `tests/integration/command-pipeline.test.js` | Parse → auth → handler → output contract |
| PR auto-review behavior | `tests/integration/pr-auto-review.test.js` | Marker upsert and PR event lifecycle |

## CONVENTIONS
- Test framework: Vitest v3 (uses vitest globals: describe/test/expect); configured via `vitest.config.js`.
- Keep tests deterministic with explicit mock payloads and marker assertions.
- Prefer scenario names that encode trigger + expected visible outcome.
- When changing comment markers or command UX, update integration snapshots/assertions immediately.

## ANTI-PATTERNS
- Deleting integration assertions to make behavior changes pass.
- Asserting only internal calls without validating user-visible output.
- Duplicating large fixtures inline when reusable fixtures already exist.

## NOTES
- Test command: `npm test` → `vitest run --coverage`.
- Coverage uploaded to Codecov.
- Integration tests are the safety net for command threading and marker idempotency.
- Integration test guide: `tests/integration/AGENTS.md`.
