# AGENTS.md

## Repository overview

JavaScript GitHub Action (`node20` runtime, `dist/index.js` entrypoint) executed by the GitHub Actions runner in response to webhook events. Three event flows:
1. **PR auto-review** on `pull_request` (opened/synchronize) — reviews changed files via Z.ai, with large-PR batching and synthesis.
2. **`/zai` commands** on PR issue/review comments (collaborator-gated) — `ask`, `review`, `explain`, `describe`, `impact`, `help`, `update-agents`.
3. **Scheduled tasks** (cron) — reads `.zai-scheduled.yml` and regenerates `AGENTS.md` files into validated PRs.

The runner executes `dist/index.js` only; maintained logic lives in `src/`. There is no server process and no published package entrypoint for programmatic consumption.

## Where to work

```text
src/index.js                       # Runtime orchestration + event dispatch (only module reading github.context)
src/lib/                           # Services: commands/auth/context/comments/api/logging/events/continuity
src/lib/handlers/                  # Per-command logic (see src/lib/handlers/AGENTS.md)
src/lib/config/scheduled-config.js # .zai-scheduled.yml loader + validators
src/lib/repository-context.js      # Real repo context collection for AGENTS.md generation
src/lib/agents-validation.js       # Hallucination guard for generated AGENTS.md output
dist/index.js                      # Generated ncc bundle — DO NOT hand-edit
action.yml                         # Action inputs + node20 contract
.zai-scheduled.yml                 # Scheduled-task config for THIS repo
.zai-scheduled.yml.template        # Consumer template
tests/                             # Vitest v3 unit + tests/integration/ e2e
vitest.config.js                   # Vitest configuration
```

## Architecture and boundaries

Strict downward dependency direction (full map and life-of-request flows in `ARCHITECTURE.md`):

```text
GitHub Actions runtime → src/index.js (orchestration)
                       → src/lib/* (services)
                       → src/lib/handlers/* (commands)
                       → src/lib/api.js + src/lib/pr-context.js (external I/O: Z.ai, GitHub)
```

Hard invariants:
- **Generated vs. source**: edit `src/`, rebuild with `npm run build`, commit `dist/index.js` + `dist/licenses.txt`. CI fails on `dist/` drift.
- **Authorization precedes execution**: command handlers run only after `enforceCommandAuthorization` (collaborator + fork policy via `src/lib/auth.js`).
- **PR-scoped commands**: `/zai` commands dispatch only on PR-context comments (non-PR issues rejected).
- **Bounded prompts**: never pass unbounded diffs/patches into prompts — sizing via `src/lib/code-scope.js` and `src/lib/context.js`.
- **Idempotent comments**: marker constants + `replyToId` threading via `src/lib/comments.js`.
- **User-safe errors**: no raw internals/secrets surfaced in PR comments (`src/lib/logging.js`).
- **External I/O through services layer**: handlers do not touch Octokit ad hoc; they go through `api.js`, `pr-context.js`, `comments.js`.

## Context routing

Read conditionally:
- Architectural or cross-module changes → `ARCHITECTURE.md`
- Operational / rollback / incident response → `RUNBOOK.md`
- Authorization rules and permission model → `SECURITY.md`
- Release process and senior review checklists → `CONTRIBUTING.md`
- Scheduled-tasks configuration reference (cron syntax, troubleshooting) → `docs/scheduled-tasks.md`
- Per-command handler behavior and conventions → `src/lib/handlers/AGENTS.md`
- Services-layer module guide → `src/lib/AGENTS.md`
- Test strategy and suite map → `tests/AGENTS.md`
- End-to-end pipeline tests → `tests/integration/AGENTS.md`

## Change rules

- Do not hand-edit `dist/index.js`. After any `src/` change run `npm run build` and commit the regenerated `dist/index.js` + `dist/licenses.txt`.
- Preserve comment marker constants (`<!-- zai-code-review -->`, `<!-- zai-progress -->`, `<!-- zai-guidance -->`, `<!-- zai-auth -->`); changing them breaks idempotent updates and integration assertions.
- Keep the `/zai` command allowlist strict (`src/lib/commands.js`); adding a command requires handler + dispatch wiring.
- External I/O (Z.ai, GitHub) must go through `src/lib/api.js` / `src/lib/pr-context.js` / `src/lib/comments.js` — no ad-hoc Octokit in handlers.
- Scheduled AGENTS.md regeneration is grounded and validated end-to-end: real tree + existing AGENTS.md → prompt → `validateGeneratedAgentFiles` (rejects non-AGENTS paths, out-of-scope writes, hallucinated file references) before PR. Do not weaken these guards.
- Fork-aware authorization: fork PR creators may run commands on their own PR; non-collaborators on forks are silently blocked.

## Validation

- Build: `npm run build` (ncc bundle into `dist/`).
- Test: `npm test` → `vitest run --coverage`.
- CI gates (`.github/workflows/ci.yml`): test, build, dist-drift (fails on uncommitted `dist/` changes), security audit.
- After changing comment markers or command UX, update integration assertions in `tests/integration/` immediately.

## Repository-specific gotchas

- `dist/` is committed and is the only artifact GitHub executes; forgetting to rebuild fails the CI dist-drift gate.
- `fetchAllChangedFiles` caps at GitHub's 3000-file API ceiling (`MAX_PR_FILES_API_LIMIT`); coverage beyond that is reported as incomplete in review notes.
- `REACTIONS.THINKING` is intentionally aliased to `eyes` in `src/lib/comments.js` — do not "fix" it without checking GitHub's reaction allowlist.
- `checkAuthorization` in `src/lib/auth.js` currently returns permissive (`identifiable_user`) for any identifiable commenter — preserve or change deliberately, do not drift.
- The `scheduled` handler is exported but is NOT in the `/zai` HANDLERS map; it is invoked only via the schedule path. The manual `/zai update-agents` command reuses `handleUpdateAgentsTask` directly.
- Default model is `glm-5.2` (`action.yml`); Z.ai endpoint is `https://api.z.ai/api/coding/paas/v4/chat/completions`.

## Key docs

- `README.md` — user-facing inputs, commands, quickstart, scheduled-tasks summary.
- `ARCHITECTURE.md` — layered architecture, dependency direction, life-of-request flows, invariant catalog.
- `CONTRIBUTING.md` — contribution guide, build/release flow, senior review checklists.
- `RUNBOOK.md` — operational runbook, rollback procedures.
- `SECURITY.md` — authorization rules and permission model.
- `docs/scheduled-tasks.md` — scheduled-tasks configuration reference, cron syntax, troubleshooting.
