# INTEGRATION TEST GUIDE

## Scope and inheritance

Applies to: `tests/integration/`.

Inherits repository-wide guidance from `AGENTS.md` and test-suite guidance from `tests/AGENTS.md`.

This file defines only local differences for integration tests.

## OVERVIEW

Integration tests verify end-to-end GitHub event pipelines and visible bot behavior, not just isolated helper logic.

## WHERE TO LOOK

| Scenario | File | Notes |
|----------|------|-------|
| Issue comment command pipeline | `tests/integration/command-pipeline.test.js` | Event classification, command parse, auth, dispatch, response shape |
| Pull request auto-review pipeline | `tests/integration/pr-auto-review.test.js` | PR event handling, marker create/update, no-change short-circuits |
| Integration fixture data | `tests/integration/fixtures/events.js` | Shared event payloads for realistic event simulation |

## CONVENTIONS

- Test the public behavior chain from event input to final comment/reaction outcome.
- Cover both happy paths and safety gates (non-PR comments, unauthorized users, empty diffs).
- Keep marker expectations explicit so idempotent update regressions are caught quickly.

## ANTI-PATTERNS

- Replacing integration assertions with unit-level mocks only.
- Ignoring failure-path expectations for auth and API errors.
- Coupling tests to unrelated implementation details that break harmless refactors.
