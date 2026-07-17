# AGENTS.md — tests/integration

## Scope and inheritance

Applies to: `tests/integration/`.

Inherits from `tests/AGENTS.md` and the root `AGENTS.md`. This file defines only local differences for end-to-end pipeline tests.

Local overrides: none.

## What lives here

```text
tests/integration/
├── command-pipeline.test.js     # Issue comment event → parse → auth → dispatch → output shape
├── pr-auto-review.test.js       # pull_request event → marker upsert / update / no-change short-circuit
└── fixtures/events.js           # Shared event payloads for realistic simulation
```

## Local boundaries and invariants

- Integration tests validate the **public behavior chain** from event input to final comment/reaction outcome, not isolated helper logic.
- Cover both happy paths and safety gates: non-PR comments, unauthorized users, empty diffs, marker collisions.
- Keep marker expectations explicit so idempotent update regressions are caught quickly.
- Shared event payloads belong in `fixtures/events.js`; static payloads live in `tests/fixtures/`.

## Anti-patterns

- Replacing integration assertions with unit-level mocks only.
- Ignoring failure-path expectations for auth and API errors.
- Coupling tests to unrelated implementation details that break harmless refactors.

## Nearby docs

- Full test map and conventions → `tests/AGENTS.md`
- Handler contracts → `src/lib/handlers/AGENTS.md`
