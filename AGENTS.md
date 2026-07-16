# AGENTS.md

## Repository overview

JavaScript GitHub Action (Node 20 runtime) with three event flows:
1. **PR auto-review** — automatic review on `opened`/`synchronize` events
2. **`/zai` PR comment commands** — collaborator-gated, parsed and authorized before dispatch
3. **Cron-triggered scheduled tasks** (`.zai-scheduled.yml`) that regenerate `AGENTS.md` files and open PRs

Runtime executes `dist/index.js` (generated ncc bundle); maintained logic lives in `src/`.

## Repository shape

```text
src/index.js                        # Runtime entrypoint: event dispatch + all pipelines
src/lib/                            # Services layer (events, commands, auth, api, context, comments)
src/lib/handlers/                   # Per-command handler modules
src/lib/config/scheduled-config.js  # Scheduled-task config loader (.zai-scheduled.yml)
tests/                              # Vitest v3 suite (unit + integration)
dist/                               # Generated ncc bundle — CI runs this, not src/
action.yml                          # Action manifest + input definitions
.zai-scheduled.yml                  # Scheduled-task config for this repo
.zai-scheduled.yml.template         # Consumer template for scheduled tasks
plans/                              # Planning docs (scheduled-tasks integration)
```

## Architecture and boundaries

Strict downward dependency direction:

```
src/index.js (orchestration) → src/lib/*.js (services) → src/lib/handlers/*.js (commands)
```

Non-negotiable invariants:
- GitHub executes `dist/index.js` only; all maintained logic lives in `src/`.
- After source changes: `npm run build` → commit `dist/index.js` + `dist/licenses.txt`.
- Command handlers run only after `enforceCommandAuthorization` succeeds.
- Automated comments are marker-idempotent (`<!-- zai-code-review -->`, `<!-- zai-progress -->`, etc.) and threaded via `replyToId`.
- Prompts use bounded context via `code-scope.js` / `context.js`; never raw unbounded patches.
- No raw exceptions or secrets surfaced in PR comments; use `src/lib/logging.js` for safe errors.

## Context routing

Read only when relevant:
- Architectural changes, dependency direction, data flows → `ARCHITECTURE.md`
- Rollback and incident response → `RUNBOOK.md`
- Authorization rules and permission model → `SECURITY.md`
- Contribution guide and review checklists → `CONTRIBUTING.md`
- Scheduled-tasks configuration reference → `docs/scheduled-tasks.md`
- Services-layer module guide → `src/lib/AGENTS.md`
- Per-command handler details → `src/lib/handlers/AGENTS.md`
- Test strategy and suite layout → `tests/AGENTS.md`
- Integration test guide → `tests/integration/AGENTS.md`

## Key symbols

| Symbol | Location | Role |
|--------|----------|------|
| `run` | `src/index.js` | Top-level event gate + dispatcher |
| `dispatchCommand` | `src/index.js` | Handler selection and response management |
| `enforceCommandAuthorization` | `src/index.js` | Auth gate before command dispatch |
| `handlePullRequestEvent` | `src/index.js` | PR auto-review flow |
| `handleIssueCommentEvent` | `src/index.js` | Issue comment command flow |
| `handleScheduledEvent` | `src/lib/handlers/scheduled.js` | Scheduled pipeline entry |
| `handleUpdateAgentsTask` | `src/lib/handlers/scheduled.js` | Grounded AGENTS.md regen: context → prompt → validate → PR |
| `parseCommand` | `src/lib/commands.js` | `/zai` parser + command allowlist |
| `checkForkAuthorization` | `src/lib/auth.js` | Fork-aware collaborator auth policy |
| `upsertComment` | `src/lib/comments.js` | Marker upsert + threaded replies + reactions |
| `callWithRetry` | `src/lib/api.js` | Z.ai API retry/backoff/timeout/fallback |
| `createReviewBatches` | `src/lib/auto-review.js` | Large PR file chunking + synthesis |
| `fetchAllChangedFiles` | `src/lib/changed-files.js` | Paginated fetch (3000-file API limit) |
| `collectRepositoryContext` | `src/lib/repository-context.js` | Real repo context for AGENTS.md generation |
| `validateGeneratedAgentFiles` | `src/lib/agents-validation.js` | Hallucination guard: rejects non-AGENTS paths, out-of-scope writes, fabricated content |
| `loadScheduledConfig` | `src/lib/config/scheduled-config.js` | `.zai-scheduled.yml` parser + task filter |

## Change rules

- Edit source in `src/`; never hand-edit `dist/index.js`.
- Handler-specific logic belongs in `src/lib/handlers/`, not in services or `src/index.js`.
- Services-layer modules stay policy-centric; orchestration stays in `src/index.js`.
- Preserve comment marker constants and their update semantics.
- Return user-safe failures; log internal details via `src/lib/logging.js`.

## Validation

- `npm test` → `vitest run --coverage`
- `npm run build` → `ncc build src/index.js -o dist --license licenses.txt`
- CI (`.github/workflows/ci.yml`) gates: test, build, dist-drift, security audit.

## Gotchas

- **dist drift**: CI fails if `dist/index.js` doesn't match a fresh `ncc` build of `src/`.
- **Two `fetchChangedFiles`**: `src/lib/changed-files.js` exports the paginated fetcher; `src/lib/context.js` also exports a `fetchChangedFiles` with truncation/range helpers. `src/index.js` imports both (aliasing the paginated one as `fetchChangedFilesPaginated`).
- **3000-file ceiling**: `changed-files.js` caps at GitHub's API limit; auto-review coverage notes flag incomplete reviews beyond that.
- **Silent fork block**: Non-collaborator commands on fork PRs are silently blocked by design (see `SECURITY.md`).
- **`scheduled` handler routing**: Not in the `/zai` command dispatcher switch; runs via cron events and the `/zai update-agents` manual command path in `src/index.js`.
- **Grounded AGENTS.md generation**: `handleUpdateAgentsTask` embeds real repo tree + existing AGENTS.md + key files into the prompt, validates output against the actual tree, and rejects hallucinated files before creating a PR.
