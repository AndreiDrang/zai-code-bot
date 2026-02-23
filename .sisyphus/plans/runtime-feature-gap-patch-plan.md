# Runtime Feature Gap Patch Plan

## TL;DR

> **Quick Summary**: Close the gap between implemented modules and shipped runtime by wiring `src/index.js` to the modular command pipeline, completing command dispatch coverage, and proving behavior through runtime-path tests.
>
> **Deliverables**:
> - Runtime wiring for `issue_comment` PR commands and full `/zai` dispatch
> - Completion of handler registry + event/authorization pipeline integration
> - Evidence that `dist/index.js` (built from `src/index.js`) reflects all required behavior
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves + final verification
> **Critical Path**: T1 -> T4 -> T7 -> T10 -> F1-F4

---

## Context

### Original Request
Create a patch plan for features that are still not present versus `ZAI-BOT-FEATURES.md`.

### Interview Summary
**Key Findings**:
- `src/lib/*` contains most feature logic (auth, parser, handlers, context, comments, continuity).
- Runtime entrypoint remains `src/index.js` -> `dist/index.js`, and it still behaves mostly as legacy PR auto-review.
- Handler registry only exposes `ask/help`; `review/explain/suggest/compare` implementations exist but are not fully runtime-dispatched.
- Current tests are broad but do not fully validate shipped runtime path for all interactive commands.

### Metis Review
**Gaps identified and adopted**:
- Missing explicit runtime integration criteria for `issue_comment` command flow.
- Missing guardrails to avoid scope creep into unrelated product features.
- Missing acceptance criteria tying implementation to `dist` artifact correctness.

### Defaults Applied
- Keep existing PR auto-review behavior intact and idempotent.
- Do not introduce new product scope beyond `ZAI-BOT-FEATURES.md`.
- Reuse existing modules; patch wiring and integration first.

---

## Work Objectives

### Core Objective
Make the shipped GitHub Action runtime fully execute the already-built modular bot capabilities so behavior matches `ZAI-BOT-FEATURES.md`.

### Concrete Deliverables
- Runtime supports `pull_request` auto-review and PR-scoped `issue_comment` command handling.
- Command dispatch supports `/zai ask|help|review|explain|suggest|compare` plus mention normalization.
- Authorization, context budget, line-range targeting, threaded replies, reactions, and continuity are active in runtime path.
- Build pipeline produces updated `dist/index.js` and tests prove runtime behavior.

### Definition of Done
- [ ] Runtime processes valid PR `issue_comment` commands end-to-end.
- [ ] All six commands dispatch through runtime entrypoint without dead paths.
- [ ] Unauthorized/non-PR/bot-loop events are safely blocked.
- [ ] `npm run build` regenerates `dist` and no drift remains.
- [ ] Runtime-path integration tests pass under `node --test`.

### Must Have
- Preserve existing marker-based idempotent comment update behavior.
- Preserve existing security posture (collaborator-only, allowlist, no shell execution).
- Keep workflow compatibility and action contract in `action.yml`.

### Must NOT Have (Guardrails)
- No dashboard/UI work, plugin framework, external DB, billing tracking, or multi-repo expansion.
- No redesign of handler business logic unless required to unblock runtime wiring.
- No manual edits in `dist/`.

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** - verification must be executable by agent.

### Test Decision
- **Infrastructure exists**: YES (`node:test` suite)
- **Automated tests**: YES (tests-after patching)
- **Framework**: Node built-in `node --test`
- **Agent QA**: Mandatory for each task with happy + negative path

### QA Policy
- Runtime-path evidence files saved under `.sisyphus/evidence/task-{N}-*.txt`.
- For event pipeline validation, use fixture-driven execution and assert observable outputs (comments/reactions/errors).

---

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Foundation wiring, 5 parallel tasks):
- T1 Runtime event contract and entrypoint routing skeleton
- T2 Handler registry completion for all `/zai` commands
- T3 Command parsing + mention normalization integration into runtime
- T4 Authorization gate + fork policy wiring in runtime command path
- T5 Shared runtime context adapter (payload -> handler context)

Wave 2 (Behavioral integration, 5 parallel tasks):
- T6 Wire `ask/help` through unified dispatcher
- T7 Wire `review/explain` through dispatcher with range/file validation path
- T8 Wire `suggest/compare` through dispatcher with diff-context budgeting
- T9 Threaded replies, reactions, and progress feedback consistency in runtime pipeline
- T10 Continuity state load/save integration across repeated PR thread commands

Wave 3 (Assurance and release alignment, 4 parallel tasks):
- T11 Runtime-path integration tests for `issue_comment` command matrix
- T12 Runtime-path regression tests for `pull_request` auto-review compatibility
- T13 Dist rebuild + drift verification and CI gate alignment
- T14 Docs alignment (`README`/runbook notes) for runtime behavior truthfulness

Wave FINAL (Independent review):
- F1 Plan compliance audit (`oracle`)
- F2 Code quality + tests/build sweep (`unspecified-high`)
- F3 QA replay of command matrix (`unspecified-high`)
- F4 Scope fidelity and anti-creep check (`deep`)

Critical Path: T1 -> T4 -> T7 -> T10 -> T11 -> F1-F4
Max Concurrent: 5

### Dependency Matrix
- T1: blocked by none | blocks T6, T7, T8, T9, T10
- T2: blocked by none | blocks T6, T7, T8
- T3: blocked by none | blocks T6, T7, T8
- T4: blocked by none | blocks T6, T7, T8, T10
- T5: blocked by none | blocks T6, T7, T8, T10
- T6: blocked by T1,T2,T3,T4,T5 | blocks T11
- T7: blocked by T1,T2,T3,T4,T5 | blocks T11
- T8: blocked by T1,T2,T3,T4,T5 | blocks T11
- T9: blocked by T1 | blocks T11
- T10: blocked by T1,T4,T5 | blocks T11
- T11: blocked by T6,T7,T8,T9,T10 | blocks F1-F4
- T12: blocked by T1 | blocks F1,F2,F4
- T13: blocked by T11,T12 | blocks F2,F4
- T14: blocked by T11 | blocks F1,F3

### Agent Dispatch Summary
- Wave 1: T1 `deep`, T2 `quick`, T3 `quick`, T4 `deep`, T5 `quick`
- Wave 2: T6 `quick`, T7 `deep`, T8 `quick`, T9 `unspecified-high`, T10 `unspecified-high`
- Wave 3: T11 `deep`, T12 `deep`, T13 `quick`, T14 `writing`
- Final: F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

- [x] T1. Add runtime event multiplexer in `src/index.js`

  **What to do**:
  - Introduce explicit branch handling for `pull_request` (auto-review flow) and PR-scoped `issue_comment` (interactive command flow).
  - Reuse `src/lib/events.js` decisions to block non-PR comments and bot-loop events.

  **Must NOT do**:
  - Do not remove legacy auto-review behavior.
  - Do not process issue comments that are not attached to PRs.

  **Recommended Agent Profile**:
  - **Category**: `deep` (runtime routing correctness)
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: T6, T7, T8, T9, T10
  - **Blocked By**: None

  **References**:
  - `src/index.js` - runtime entrypoint currently tied to legacy PR path
  - `src/lib/events.js` - canonical event typing and shouldProcess guard
  - `.github/workflows/code-review.yml` - trigger truth for PR and issue_comment events

  **Acceptance Criteria**:
  - [ ] Runtime selects correct flow by event type (`pull_request` vs `issue_comment`).
  - [ ] Non-PR issue comments are ignored safely.
  - [ ] Bot-authored comments are not reprocessed.

  **QA Scenarios**:
  - Happy: replay PR `opened` fixture, assert auto-review path executes and comment marker flow remains idempotent.
  - Negative: replay non-PR issue comment fixture, assert no command execution/API call.

- [x] T2. Complete handler registry exports for all six commands

  **What to do**:
  - Update `src/lib/handlers/index.js` so registry includes `ask`, `help`, `review`, `explain`, `suggest`, `compare`.
  - Keep command-to-handler mapping deterministic.

  **Must NOT do**:
  - Do not alter handler business logic unless wiring defect is discovered.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: T6, T7, T8
  - **Blocked By**: None

  **References**:
  - `src/lib/handlers/index.js`
  - `src/lib/handlers/review.js`
  - `src/lib/handlers/explain.js`
  - `src/lib/handlers/suggest.js`
  - `src/lib/handlers/compare.js`

  **Acceptance Criteria**:
  - [ ] Registry returns all six commands.
  - [ ] Unknown command resolution still returns null/safe path.

  **QA Scenarios**:
  - Happy: command registry lookup succeeds for each allowed command.
  - Negative: lookup unknown command and assert no handler returned.

- [x] T3. Integrate command parser + mention normalization in runtime path

  **What to do**:
  - Use `parseCommand`/mention normalization for issue comment body parsing in runtime flow.
  - Enforce allowlist and safe error responses for malformed/unknown input.

  **Must NOT do**:
  - Do not introduce dynamic eval or shell-style command handling.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: T6, T7, T8
  - **Blocked By**: None

  **References**:
  - `src/lib/commands.js` - parser, allowlist, mention normalization
  - `tests/commands.test.js` - expected parser behavior

  **Acceptance Criteria**:
  - [ ] `/zai ...` and `@zai-bot ...` forms parse correctly.
  - [ ] Unknown/malformed commands return safe guidance response.

  **QA Scenarios**:
  - Happy: parse `/zai explain 10-15` and dispatch explain.
  - Negative: parse `/zai foobar` and assert safe unknown-command response.

- [x] T4. Wire collaborator auth + fork policy to command execution

  **What to do**:
  - Integrate `src/lib/auth.js` checks before any command handler invocation.
  - Apply silent block behavior for unauthorized fork-origin interactions where policy requires.

  **Must NOT do**:
  - Do not weaken authorized permission set.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: T6, T7, T8, T10
  - **Blocked By**: None

  **References**:
  - `src/lib/auth.js`
  - `SECURITY.md`
  - `tests/auth.test.js`

  **Acceptance Criteria**:
  - [ ] Non-collaborators cannot execute bot commands.
  - [ ] Authorized collaborators can execute commands on PR comments.

  **QA Scenarios**:
  - Happy: collaborator comment executes handler and posts response.
  - Negative: non-collaborator comment is blocked, no provider call.

- [x] T5. Build runtime context adapter for unified handler invocation

  **What to do**:
  - Normalize runtime payload into handler context object (octokit, owner/repo, PR number, comment context, file diffs, budget config).
  - Ensure all handlers receive consistent fields they already expect.

  **Must NOT do**:
  - Do not duplicate logic already available in `src/lib/context.js` and utilities.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Blocks**: T6, T7, T8, T10
  - **Blocked By**: None

  **References**:
  - `src/lib/context.js`
  - `src/lib/comments.js`
  - `src/lib/api.js`

  **Acceptance Criteria**:
  - [ ] Context object satisfies ask/help/review/explain/suggest/compare handler needs.
  - [ ] Missing fields fail safely with typed error and no crash.

  **QA Scenarios**:
  - Happy: run one handler from runtime and confirm context-dependent fields resolve.
  - Negative: omit required context field in fixture and assert safe error handling.

- [ ] T6. Route `/zai ask` and `/zai help` through unified runtime dispatcher

  **What to do**:
  - Replace ad hoc command handling with registry-driven dispatch for ask/help.
  - Ensure threaded response and marker behavior remain stable.

  **Must NOT do**:
  - Do not regress existing ask/help response formatting.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2)
  - **Blocks**: T11
  - **Blocked By**: T1,T2,T3,T4,T5

  **References**:
  - `src/lib/handlers/ask.js`
  - `src/lib/handlers/help.js`
  - `src/lib/comments.js`

  **Acceptance Criteria**:
  - [ ] Ask/help commands execute from issue_comment runtime path.
  - [ ] Responses are posted as threaded updates where applicable.

  **QA Scenarios**:
  - Happy: execute `/zai ask explain auth flow` fixture and assert response comment exists.
  - Negative: empty ask input returns validation guidance.

- [ ] T7. Route `/zai review` and `/zai explain` through runtime dispatcher

  **What to do**:
  - Dispatch review/explain commands via registry into existing handlers.
  - Preserve file-target validation and line-range validation behavior.

  **Must NOT do**:
  - Do not bypass range/path validation safeguards.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2)
  - **Blocks**: T11
  - **Blocked By**: T1,T2,T3,T4,T5

  **References**:
  - `src/lib/handlers/review.js`
  - `src/lib/handlers/explain.js`
  - `src/lib/context.js`

  **Acceptance Criteria**:
  - [ ] `/zai review <path>` validates file is in PR and returns actionable output.
  - [ ] `/zai explain <range>` validates and explains only requested lines.

  **QA Scenarios**:
  - Happy: `/zai explain 10-15` returns focused explanation.
  - Negative: `/zai explain 10000-10020` returns safe out-of-range message.

- [ ] T8. Route `/zai suggest` and `/zai compare` through runtime dispatcher

  **What to do**:
  - Dispatch suggest/compare commands and apply context truncation before API call.
  - Ensure output formatting and error typing match established handler behavior.

  **Must NOT do**:
  - Do not send unbounded patch payloads to provider.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2)
  - **Blocks**: T11
  - **Blocked By**: T1,T2,T3,T4,T5

  **References**:
  - `src/lib/handlers/suggest.js`
  - `src/lib/handlers/compare.js`
  - `src/lib/context.js`

  **Acceptance Criteria**:
  - [ ] Suggest and compare commands execute through runtime and return command-tagged responses.
  - [ ] Oversized diff context is truncated with explicit indicator.

  **QA Scenarios**:
  - Happy: `/zai compare` produces old-vs-new analysis response.
  - Negative: provider timeout surfaces sanitized timeout category message.

- [ ] T9. Standardize reactions + progress feedback in command pipeline

  **What to do**:
  - Ensure command lifecycle includes acknowledgement reaction and completion/error state update.
  - Normalize behavior across all six handlers.

  **Must NOT do**:
  - Do not create noisy multi-comment progress spam.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2)
  - **Blocks**: T11
  - **Blocked By**: T1

  **References**:
  - `src/lib/comments.js`
  - `src/lib/handlers/ask.js`
  - `src/lib/handlers/help.js`

  **Acceptance Criteria**:
  - [ ] Commands emit acknowledgment feedback and terminal result feedback.
  - [ ] Failure paths update feedback without leaking internals.

  **QA Scenarios**:
  - Happy: valid command gets initial reaction then final response.
  - Negative: provider failure yields error reaction/message with sanitized text.

- [ ] T10. Integrate continuity state through runtime command loop

  **What to do**:
  - Load continuity state from prior bot comment/thread context and save updated state after command completion.
  - Keep payload within state-size cap.

  **Must NOT do**:
  - Do not persist raw secrets or full diff bodies in continuity payload.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2)
  - **Blocks**: T11
  - **Blocked By**: T1,T4,T5

  **References**:
  - `src/lib/continuity.js`
  - `src/lib/comments.js`

  **Acceptance Criteria**:
  - [ ] Consecutive commands in same PR thread can reuse prior context summary.
  - [ ] Invalid/oversized continuity payload is handled gracefully.

  **QA Scenarios**:
  - Happy: run two sequential commands, second reflects stored context.
  - Negative: inject invalid continuity marker, assert fallback path and no crash.

- [ ] T11. Add runtime-path integration tests for full issue_comment command matrix

  **What to do**:
  - Add/extend integration tests to execute runtime entrypoint for each command: ask/help/review/explain/suggest/compare.
  - Ensure tests assert event -> auth -> parse -> dispatch -> provider -> comment/reaction sequence.

  **Must NOT do**:
  - Do not rely only on isolated module tests.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: F1,F2,F3,F4
  - **Blocked By**: T6,T7,T8,T9,T10

  **References**:
  - `tests/integration/command-pipeline.test.js`
  - `src/index.js`
  - `tests/fixtures/`

  **Acceptance Criteria**:
  - [ ] All six commands pass runtime-path integration tests.
  - [ ] Unauthorized and malformed command cases are covered.

  **QA Scenarios**:
  - Happy: `node --test tests/integration` passes command matrix tests.
  - Negative: unauthorized command fixture asserts zero provider call.

- [ ] T12. Add runtime regression tests for pull_request auto-review compatibility

  **What to do**:
  - Validate existing PR opened/synchronize auto-review behavior remains intact after routing changes.
  - Assert idempotent marker update still works.

  **Must NOT do**:
  - Do not change expected public auto-review output contract unless explicitly required.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: F1,F2,F4
  - **Blocked By**: T1

  **References**:
  - `tests/integration/pr-auto-review.test.js`
  - `src/index.js`
  - `src/lib/comments.js`

  **Acceptance Criteria**:
  - [ ] PR opened and synchronize events still generate/update review comment.
  - [ ] Marker-based upsert remains idempotent.

  **QA Scenarios**:
  - Happy: opened event creates review comment.
  - Negative: synchronize event updates existing marker comment instead of duplicating.

- [ ] T13. Rebuild dist and enforce dist-drift guard alignment

  **What to do**:
  - Run build to regenerate `dist/index.js` from patched `src/index.js`.
  - Ensure CI gate verifies no `dist` drift after build.

  **Must NOT do**:
  - Do not hand-edit `dist/index.js`.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: F2,F4
  - **Blocked By**: T11,T12

  **References**:
  - `package.json` (build script)
  - `dist/index.js`
  - `.github/workflows/ci.yml`

  **Acceptance Criteria**:
  - [ ] `npm run build` completes successfully.
  - [ ] `git diff --exit-code dist/` passes after rebuild.

  **QA Scenarios**:
  - Happy: build and drift check pass.
  - Negative: intentionally stale dist in fixture branch triggers drift failure.

- [ ] T14. Align docs with runtime truth (no feature overstatement)

  **What to do**:
  - Update docs to reflect actual runtime-supported command and trigger behavior.
  - Clarify safety and permission behavior for issue_comment commands.

  **Must NOT do**:
  - Do not claim capabilities not verified by tests.

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: `git-master`

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3)
  - **Blocks**: F1,F3
  - **Blocked By**: T11

  **References**:
  - `README.md`
  - `RUNBOOK.md`
  - `ZAI-BOT-FEATURES.md`

  **Acceptance Criteria**:
  - [ ] Docs match tested runtime behavior.
  - [ ] Command usage examples are accurate and safe.

  **QA Scenarios**:
  - Happy: doc examples map to passing test cases.
  - Negative: mismatch scan finds zero claims without implementation/test backing.

---

## Final Verification Wave

- [ ] F1. Plan Compliance Audit (`oracle`)
  Verify every plan task maps to implemented runtime behavior and evidence artifacts.

- [ ] F2. Build/Test/Quality Sweep (`unspecified-high`)
  Run `node --test` and `npm run build`; reject on failures or runtime regressions.

- [ ] F3. Command Matrix QA Replay (`unspecified-high`)
  Re-run happy + negative command scenarios for all six commands and capture evidence.

- [ ] F4. Scope Fidelity Check (`deep`)
  Ensure no out-of-scope features were added while patching runtime wiring.

---

## Commit Strategy

- Wave 1 commit: `refactor(runtime): wire command pipeline foundation`
- Wave 2 commit: `feat(runtime): dispatch all zai commands through entrypoint`
- Wave 3 commit: `test(ci): add runtime-path integration and dist safeguards`

---

## Success Criteria

### Verification Commands
```bash
node --test
npm run build
git diff --exit-code dist/
```

### Final Checklist
- [ ] All required runtime features from `ZAI-BOT-FEATURES.md` are active in shipped path.
- [ ] All command handlers are dispatched through runtime, not dead code.
- [ ] Security and budget guardrails remain enforced.
- [ ] Dist artifact is regenerated and in sync.
