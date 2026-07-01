# TEST SUITE GUIDE

## OVERVIEW
Repository test coverage mixes module-focused tests in `tests/*.test.js` and scenario-driven flows in `tests/integration/*`.

## STRUCTURE
```text
tests/
├── *.test.js        # Module-level tests for lib/runtime units
├── handlers/        # Handler-focused test helpers/cases
├── helpers/         # Shared mocks and fixtures utilities
├── lib/             # Shared test helpers (e.g. events.js) + code-scope tests
├── fixtures/        # Static test payloads
└── integration/     # End-to-end command/review pipeline checks
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Parser/auth/comment unit behavior | `tests/commands.test.js`, `tests/auth.test.js`, `tests/comments.test.js` | Fast regression checks |
| Runtime orchestration checks | `tests/action.test.js`, `tests/handlers.test.js` | Entry flow and dispatch behavior |
| API and logging resilience | `tests/api.test.js`, `tests/logging.test.js` | Retry/error categorization |
| Context, PR fetch, and batching | `tests/context.test.js`, `tests/pr-context.test.js`, `tests/changed-files.test.js`, `tests/auto-review.test.js` | Diff scoping, file-at-ref fetch, paginated/batched review |
| Continuity and events | `tests/continuity.test.js`, `tests/events.test.js` | Hidden-marker state, event-type detection |
| Scheduled pipeline | — | **GAP:** no tests for `scheduled.js` / `scheduled-config.js` yet (flagged in `plans/*`). Add unit (config load, `getTasksToRun`, `parseFileUpdatesFromResponse`) + integration (schedule event → PR) coverage. |
| Full command pipeline | `tests/integration/command-pipeline.test.js` | Parse -> auth -> handler -> output contract |
| PR auto-review behavior | `tests/integration/pr-auto-review.test.js` | Marker upsert and PR event lifecycle |

## CONVENTIONS
- Test framework: Vitest v3 (uses vitest globals: describe/test/expect).
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
- Large test files: tests/index.test.js (1057 lines), tests/integration/command-pipeline.test.js (664 lines), tests/pr-context.test.js.
