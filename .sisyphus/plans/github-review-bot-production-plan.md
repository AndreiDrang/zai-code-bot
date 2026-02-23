# Production GitHub Review Bot Plan (GitHub Actions)

## TL;DR

> **Quick Summary**: Evolve the current PR auto-review action into a secure, interactive review bot with `issue_comment` slash commands, strict authorization, and production-grade reliability controls.
>
> **Deliverables**:
> - Event router for `pull_request` + `issue_comment` with command execution pipeline
> - Secure command handling (allowlist, collaborator checks, anti-loop, budget/rate controls)
> - Operational hardening (tests, CI checks, release/version discipline, runbooks)
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves + final verification wave
> **Critical Path**: Task 1 -> Task 3 -> Task 7 -> Task 11 -> Task 15 -> Final Wave

---

## Context

### Original Request
Analyze `ZAI-BOT-FEATURES.md` and produce a detailed, production-ready implementation plan for a GitHub review bot via GitHub Actions that would be approved by senior JavaScript, DevOps, and DevSecOps reviewers.

### Interview Summary
**Key Discussions**:
- Feature set from `ZAI-BOT-FEATURES.md`: triggers (`pull_request`, `issue_comment`), slash commands (`/zai ask/review/explain/suggest/compare/help`), threaded replies, context-aware targeting, line-range explanation, continuity, and UX feedback.
- Security/operations are mandatory: collaborator-only invocation, strict command whitelist, token/context budgets, least privilege permissions, and release hygiene.

**Research Findings**:
- Current implementation is centralized in `src/index.js` with marker-based idempotent comment updates and PR-only behavior.
- Current project has no test infrastructure and no `npm test` script; test setup must be planned as part of implementation.
- Official guidance supports explicit permissions, issue_comment PR filtering, input hardening, and secure secret handling.

### Metis Review
**Identified Gaps** (addressed in this plan):
- Missing explicit guardrails for command auth, fork behavior, bot-loop prevention, and budget/rate controls.
- Missing acceptance criteria for security and reliability failure paths.
- Missing edge-case handling for non-PR comments, oversized diffs, API partial failures, and comment races.

### Oracle Architecture Validation
**Architecture corrections incorporated**:
- Split into modular concerns (`events`, `auth`, `commands`, `context`, `api`, `comments`, `config`) while preserving action entrypoint and dist artifact flow.
- Add non-negotiable gates: auth-before-execution, timeout+retry, deterministic command parser, CI dist-drift check, and sanitized failure reporting.

### Defaults Applied (Explicit)
- `/zai help` uses the same collaborator-only authorization boundary as all commands.
- Auto-review remains enabled on `pull_request` `opened` and `synchronize`.
- Interactive command execution on fork-origin PR comments is blocked unless commenter is authorized collaborator.
- Default rate policy: max 10 commands per user per hour, max 30 commands per PR per hour.
- Tests-after strategy is used (not strict TDD), with mandatory executable QA scenarios per task.

---

## Work Objectives

### Core Objective
Deliver a secure and maintainable GitHub Actions bot that keeps existing PR auto-review behavior while adding collaborator-gated interactive `/zai` commands on PR comments.

### Concrete Deliverables
- Event-driven bot behavior for PR and PR-comment flows.
- Command parser/dispatcher for `/zai` and mention-based commands.
- Security controls: auth gates, allowlist parsing, anti-injection handling, fork policy, rate/token guardrails.
- Production operations: tests, CI, release process, and runbook updates.

### Definition of Done
- [ ] `pull_request` auto-review still works and remains idempotent.
- [ ] `/zai` commands execute only for authorized collaborators on PR comments.
- [ ] Unknown/malformed commands return safe help response without side effects.
- [ ] Timeout/retry/rate/token controls prevent runaway calls and noisy failures.
- [ ] Build artifact and release workflow remain valid (`npm run build`, dist committed).

### Must Have
- Existing marker-based comment upsert behavior preserved.
- Explicit workflow permissions and event filtering.
- Clear audit-friendly logs and deterministic error taxonomy.

### Must NOT Have (Guardrails)
- No shell execution from user-provided command text.
- No secret leakage into logs or comments.
- No command execution by non-collaborators.
- No manual edits to `dist/index.js`.
- No unbounded diff/context payloads sent to AI API.

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - all verification is agent-executed.

### Test Decision
- **Infrastructure exists**: NO
- **Automated tests**: YES (tests-after setup in early wave, then integrated into implementation)
- **Framework**: Node.js built-in `node:test` + optional lightweight mocks
- **If TDD**: N/A for this plan (tests-after chosen), but each task still includes executable QA scenarios.

### QA Policy
Evidence path convention:
- `.sisyphus/evidence/task-{N}-{scenario-slug}.txt`
- `.sisyphus/evidence/task-{N}-{scenario-slug}.json`
- `.sisyphus/evidence/task-{N}-{scenario-slug}.png` (for UI/browser steps if used)

Required tools by domain:
- **Action/API behavior**: Bash (`node`, `npm`, `curl`, `gh api`)
- **Workflow/event simulation**: Bash + fixture payloads
- **PR comment behavior**: GitHub API calls via `gh api` in controlled test repo context

---

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Foundation + contracts, parallel):
- Task 1: Event model and workflow trigger expansion
- Task 2: Security policy + permission matrix + config contracts
- Task 3: Slash-command grammar/parser contract
- Task 4: Context budget and truncation strategy
- Task 5: Test harness/bootstrap for action runtime

Wave 2 (Core backend mechanics, parallel):
- Task 6: Collaborator authorization gate
- Task 7: Event router + anti-loop guards
- Task 8: AI client hardening (timeout/retry/error taxonomy)
- Task 9: Comment/reaction idempotency and thread-reply utilities
- Task 10: Observability and structured logging baseline

Wave 3 (Feature handlers, parallel):
- Task 11: `/zai ask` + `/zai help` + mention normalization
- Task 12: `/zai review` + `/zai explain <lines>` targeting
- Task 13: `/zai suggest` + `/zai compare` contextual behavior
- Task 14: Conversation continuity model and state encoding

Wave 4 (Productionization + integration):
- Task 15: End-to-end command and event integration tests
- Task 16: DevSecOps hardening checks in CI pipeline
- Task 17: Release/runbook updates + operational readiness gates

Wave FINAL (independent 4-way review):
- Task F1: Plan compliance audit (oracle)
- Task F2: Code quality + build/lint/test sweep (unspecified-high)
- Task F3: Real scenario QA replay from all task evidence (unspecified-high)
- Task F4: Scope fidelity and anti-creep verification (deep)

Critical Path: 1 -> 3 -> 7 -> 11 -> 15 -> FINAL
Parallel Speedup: ~60% vs sequential execution
Max Concurrent: 5 (Waves 1 and 2)

### Dependency Matrix (full)
- **1**: Blocked By: none | Blocks: 7, 15
- **2**: Blocked By: none | Blocks: 6, 7, 16
- **3**: Blocked By: none | Blocks: 7, 11, 12, 13
- **4**: Blocked By: none | Blocks: 8, 11, 12, 13
- **5**: Blocked By: none | Blocks: 15, 16
- **6**: Blocked By: 2 | Blocks: 11, 12, 13
- **7**: Blocked By: 1, 2, 3 | Blocks: 11, 12, 13, 14, 15
- **8**: Blocked By: 4 | Blocks: 11, 12, 13, 15
- **9**: Blocked By: 7 | Blocks: 11, 12, 13, 14, 15
- **10**: Blocked By: 7 | Blocks: 15, 16, 17
- **11**: Blocked By: 6, 7, 8, 9 | Blocks: 15
- **12**: Blocked By: 6, 7, 8, 9 | Blocks: 15
- **13**: Blocked By: 6, 7, 8, 9 | Blocks: 15
- **14**: Blocked By: 7, 9 | Blocks: 15
- **15**: Blocked By: 1, 5, 7, 8, 9, 11, 12, 13, 14 | Blocks: 16, 17, F1-F4
- **16**: Blocked By: 2, 5, 10, 15 | Blocks: F2, F4
- **17**: Blocked By: 10, 15 | Blocks: F1, F3

### Agent Dispatch Summary
- **Wave 1**: T1 `quick`, T2 `deep`, T3 `quick`, T4 `deep`, T5 `quick`
- **Wave 2**: T6 `deep`, T7 `deep`, T8 `unspecified-high`, T9 `quick`, T10 `unspecified-high`
- **Wave 3**: T11 `quick`, T12 `deep`, T13 `quick`, T14 `unspecified-high`
- **Wave 4**: T15 `deep`, T16 `unspecified-high`, T17 `writing`
- **FINAL**: F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

- [x] 1. Expand workflow events and gating conditions

  **What to do**:
  - Update workflow trigger model to include `issue_comment` with PR-only guard while preserving `pull_request` opened/synchronize auto-review.
  - Define explicit job-level `if` conditions for non-PR issue comments to no-op safely.

  **Must NOT do**:
  - Do not broaden permissions beyond required write scopes.
  - Do not trigger commands on plain issues.

  **Recommended Agent Profile**:
  - **Category**: `quick` (small, deterministic workflow/config edits)
  - **Skills**: [`git-master`]
    - `git-master`: keeps atomic workflow commits and traceability.
  - **Skills Evaluated but Omitted**:
    - `playwright`: no browser work required.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2-5)
  - **Blocks**: 7, 15
  - **Blocked By**: None

  **References**:
  - `.github/workflows/code-review.yml` - current trigger and permission baseline to extend.
  - `ZAI-BOT-FEATURES.md` - required trigger behavior.
  - `README.md` - external usage contract requiring updates after workflow changes.

  **Acceptance Criteria**:
  - [ ] Workflow includes `issue_comment` event handling and PR-only filtering logic.
  - [ ] Existing `pull_request` auto-review trigger behavior remains intact.
  - [ ] Permissions remain least-privilege and explicitly declared.

  **QA Scenarios**:
  ```
  Scenario: PR comment event is accepted
    Tool: Bash (gh api)
    Preconditions: test PR exists
    Steps:
      1. Trigger run context with issue_comment payload containing `issue.pull_request`.
      2. Verify workflow evaluation path selects bot job.
      3. Assert log contains eventName=issue_comment and PR guard pass.
    Expected Result: command pipeline proceeds to handler entry.
    Failure Indicators: workflow skipped despite PR comment payload.
    Evidence: .sisyphus/evidence/task-1-pr-comment-accepted.txt

  Scenario: Non-PR issue comment is rejected safely
    Tool: Bash (gh api)
    Preconditions: issue (not PR) exists
    Steps:
      1. Trigger issue_comment payload without `issue.pull_request`.
      2. Assert job exits with no command execution.
    Expected Result: no-op with informational log only.
    Evidence: .sisyphus/evidence/task-1-non-pr-rejected.txt
  ```

  **Commit**: YES
  - Message: `chore(workflow): add issue_comment trigger with pr-only gating`
  - Files: `.github/workflows/code-review.yml`, `README.md`
  - Pre-commit: `npm run build`

- [x] 2. Define security policy and permission matrix

  **What to do**:
  - Create policy section in docs for authorization, fork behavior, command execution boundaries, and error visibility rules.
  - Map required GitHub token permissions per operation.

  **Must NOT do**:
  - Do not leave ambiguous rules for collaborator vs non-collaborator command execution.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: keeps docs + policy commits auditable.
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: unrelated.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 6, 7, 16
  - **Blocked By**: None

  **References**:
  - `action.yml` - current auth inputs and defaults.
  - `.github/workflows/code-review.yml` - current permissions baseline.
  - `ZAI-BOT-FEATURES.md` - collaborator-only and whitelist requirements.

  **Acceptance Criteria**:
  - [ ] Permission matrix maps each API action to minimum token scope.
  - [ ] Fork PR command policy is explicit and testable.
  - [ ] Unknown/unauthorized commands have defined safe response behavior.

  **QA Scenarios**:
  ```
  Scenario: Permission matrix covers all command paths
    Tool: Bash
    Preconditions: policy document drafted
    Steps:
      1. Enumerate command handlers (`ask/review/explain/suggest/compare/help`).
      2. Match each handler to required scopes in matrix.
      3. Assert no handler has undefined scope mapping.
    Expected Result: complete 1:1 command-to-scope mapping.
    Evidence: .sisyphus/evidence/task-2-scope-matrix.txt

  Scenario: Unauthorized policy path is explicit
    Tool: Bash
    Preconditions: policy document drafted
    Steps:
      1. Locate unauthorized user flow section.
      2. Assert action outcome is deterministic (reject + safe message/no-op).
    Expected Result: no ambiguous auth behavior remains.
    Evidence: .sisyphus/evidence/task-2-unauthorized-path.txt
  ```

  **Commit**: YES
  - Message: `docs(security): define command auth and permission matrix`
  - Files: `README.md`, `CONTRIBUTING.md` (or security section file)
  - Pre-commit: `npm run build`

- [x] 3. Implement slash-command grammar and parser contract

  **What to do**:
  - Define strict parser for `/zai` commands and mention aliases.
  - Enforce allowlist: `ask`, `review`, `explain`, `suggest`, `compare`, `help`.
  - Define structured parse output and failure taxonomy (`unknown`, `malformed`, `empty`).

  **Must NOT do**:
  - Do not execute free-form shell or dynamic eval paths.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: ensures isolated parser commit and easy rollback.
  - **Skills Evaluated but Omitted**:
    - `playwright`: no UI.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 7, 11, 12, 13
  - **Blocked By**: None

  **References**:
  - `ZAI-BOT-FEATURES.md` - command syntax contract.
  - `src/index.js` - existing text construction style and error path conventions.

  **Acceptance Criteria**:
  - [ ] Parser accepts only allowlisted commands and normalized aliases.
  - [ ] Parser returns deterministic structured errors for malformed input.
  - [ ] Unit tests cover each valid command and invalid inputs.

  **QA Scenarios**:
  ```
  Scenario: Valid commands parse deterministically
    Tool: Bash (node --test)
    Preconditions: parser tests created
    Steps:
      1. Run command fixtures for `/zai ask hi`, `/zai review src/index.js`, `/zai explain 10-15`.
      2. Assert parsed output includes `command`, `args`, and normalized fields.
    Expected Result: all valid fixtures pass.
    Evidence: .sisyphus/evidence/task-3-valid-parser.txt

  Scenario: Unknown command is rejected
    Tool: Bash (node --test)
    Preconditions: parser tests created
    Steps:
      1. Execute fixture `/zai rm -rf`.
      2. Assert parser returns `unknown_command` without side effects.
    Expected Result: reject with safe error object.
    Evidence: .sisyphus/evidence/task-3-unknown-command.txt
  ```

  **Commit**: YES
  - Message: `feat(parser): add strict zai slash command grammar`
  - Files: `src/*parser*`, tests
  - Pre-commit: `node --test`

- [x] 4. Implement context budget and truncation strategy

  **What to do**:
  - Add deterministic file/diff selection and truncation policy for prompt construction.
  - Add per-request max context size and truncation markers.
  - Define line-range extraction behavior for `/zai explain <start-end>`.

  **Must NOT do**:
  - Do not send unbounded patch payloads.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: keeps risky prompt-budget changes isolated.
  - **Skills Evaluated but Omitted**:
    - `dev-browser`: unnecessary.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8, 11, 12, 13
  - **Blocked By**: None

  **References**:
  - `src/index.js` (`buildPrompt`) - current context assembly logic.
  - `ZAI-BOT-FEATURES.md` - token budget and line-range targeting requirement.

  **Acceptance Criteria**:
  - [ ] Context builder enforces configurable max bytes/characters.
  - [ ] Truncated outputs include explicit marker indicating omission.
  - [ ] Line-range extraction validates bounds and rejects invalid ranges.

  **QA Scenarios**:
  ```
  Scenario: Oversized diff is truncated safely
    Tool: Bash (node --test)
    Preconditions: synthetic large diff fixture
    Steps:
      1. Build prompt from oversized patch input.
      2. Assert output length <= configured cap.
      3. Assert output contains truncation marker.
    Expected Result: bounded prompt with deterministic marker.
    Evidence: .sisyphus/evidence/task-4-large-diff-truncation.txt

  Scenario: Invalid line range is rejected
    Tool: Bash (node --test)
    Preconditions: explain-range parser test
    Steps:
      1. Submit `/zai explain 30-10`.
      2. Assert validation error `invalid_range`.
    Expected Result: no API call attempted for invalid range.
    Evidence: .sisyphus/evidence/task-4-invalid-range.txt
  ```

  **Commit**: YES
  - Message: `feat(context): enforce prompt budget and range validation`
  - Files: `src/*context*`, tests
  - Pre-commit: `node --test`

- [x] 5. Bootstrap automated test harness for action runtime

  **What to do**:
  - Add test runner setup and baseline fixtures for PR and issue_comment payloads.
  - Add mock strategy for Octokit and external API client calls.
  - Add CI test command integration.

  **Must NOT do**:
  - Do not introduce heavy framework overhead that conflicts with minimal-toolchain repo style.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: clean setup commit for infrastructure bootstrap.
  - **Skills Evaluated but Omitted**:
    - `frontend-design`: irrelevant.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 15, 16
  - **Blocked By**: None

  **References**:
  - `package.json` - scripts and dependency footprint conventions.
  - `.github/workflows/code-review.yml` - workflow command integration point.

  **Acceptance Criteria**:
  - [ ] `node --test` executes successfully with baseline test files.
  - [ ] PR payload and issue_comment payload fixtures exist and are reusable.
  - [ ] Mocking approach covers GitHub API + external AI API boundaries.

  **QA Scenarios**:
  ```
  Scenario: Test runner executes baseline suite
    Tool: Bash
    Preconditions: test harness added
    Steps:
      1. Run `node --test`.
      2. Assert baseline tests pass and exit code is 0.
    Expected Result: deterministic test execution.
    Evidence: .sisyphus/evidence/task-5-test-runner.txt

  Scenario: Fixture contract mismatch fails fast
    Tool: Bash
    Preconditions: malformed payload fixture
    Steps:
      1. Run fixture validation test for malformed payload.
      2. Assert test fails with clear schema mismatch error.
    Expected Result: fixture validation catches malformed events.
    Evidence: .sisyphus/evidence/task-5-bad-fixture.txt
  ```

  **Commit**: YES
  - Message: `test(infra): bootstrap node test harness for action`
  - Files: tests, `package.json`, workflow
  - Pre-commit: `node --test`

- [ ] 6. Implement collaborator authorization gate

  **What to do**:
  - Add authorization check using GitHub collaborator permission API before command execution.
  - Enforce collaborator-only policy for all `/zai` commands (including `/zai help` by default).
  - Add clear safe response/no-op policy for unauthorized users.

  **Must NOT do**:
  - Do not authorize based only on comment text or display name.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: helps maintain strict security-focused commit boundaries.
  - **Skills Evaluated but Omitted**:
    - `playwright`: no browser validation needed.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 7-10)
  - **Blocks**: 11, 12, 13
  - **Blocked By**: 2

  **References**:
  - `src/index.js` - current execution entry to gate.
  - `ZAI-BOT-FEATURES.md` - collaborator-only requirement.
  - GitHub collaborators API docs - authorization endpoint contract.

  **Acceptance Criteria**:
  - [ ] Unauthorized commenter commands are rejected before parse/dispatch.
  - [ ] Authorized collaborator commands proceed normally.
  - [ ] Authorization failures never reveal secrets or internal stack traces.

  **QA Scenarios**:
  ```
  Scenario: Collaborator command proceeds
    Tool: Bash (gh api + node --test)
    Preconditions: collaborator fixture user
    Steps:
      1. Simulate issue_comment command from collaborator.
      2. Assert collaborator endpoint returns allowed permission.
      3. Assert dispatcher is invoked.
    Expected Result: command path continues.
    Evidence: .sisyphus/evidence/task-6-collaborator-allowed.txt

  Scenario: Non-collaborator command blocked
    Tool: Bash (gh api + node --test)
    Preconditions: non-collaborator fixture user
    Steps:
      1. Simulate issue_comment command from external user.
      2. Assert dispatcher is not invoked.
    Expected Result: safe reject/no-op policy executed.
    Evidence: .sisyphus/evidence/task-6-non-collaborator-blocked.txt
  ```

  **Commit**: YES
  - Message: `feat(auth): gate commands to repository collaborators`
  - Files: `src/*auth*`, tests
  - Pre-commit: `node --test`

- [ ] 7. Implement event router and anti-loop protections

  **What to do**:
  - Refactor action entrypoint into event router handling PR and issue_comment paths.
  - Add guards for bot/self comments and non-PR issue comments.
  - Preserve existing PR auto-review behavior path.

  **Must NOT do**:
  - Do not break marker-based idempotent PR review updates.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: safe refactor tracking and rollbacks.
  - **Skills Evaluated but Omitted**:
    - `dev-browser`: not needed.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 11, 12, 13, 14, 15
  - **Blocked By**: 1, 2, 3

  **References**:
  - `src/index.js` (`run`, `getChangedFiles`, comment upsert path) - core flow to preserve.
  - `.github/workflows/code-review.yml` - trigger model consumed by router.

  **Acceptance Criteria**:
  - [ ] Event router supports both PR and issue_comment flows.
  - [ ] Bot/self comments are ignored to prevent recursion.
  - [ ] Non-PR issue comments are ignored safely.

  **QA Scenarios**:
  ```
  Scenario: Router dispatches pull_request event correctly
    Tool: Bash (node --test)
    Preconditions: PR event fixture
    Steps:
      1. Feed PR fixture to router.
      2. Assert PR auto-review handler called.
    Expected Result: existing PR flow preserved.
    Evidence: .sisyphus/evidence/task-7-pr-route.txt

  Scenario: Bot comment is dropped to avoid loop
    Tool: Bash (node --test)
    Preconditions: issue_comment fixture with `user.type=Bot`
    Steps:
      1. Feed bot-comment fixture to router.
      2. Assert command handler is not called.
    Expected Result: no recursive execution.
    Evidence: .sisyphus/evidence/task-7-bot-loop-guard.txt
  ```

  **Commit**: YES
  - Message: `refactor(router): split pr and comment event handling`
  - Files: `src/index.js`, event modules, tests
  - Pre-commit: `node --test`

- [ ] 8. Harden AI client reliability and failure taxonomy

  **What to do**:
  - Add request timeout, bounded retries with backoff, and categorized error responses.
  - Ensure failures are sanitized and user-facing messages are deterministic.
  - Keep current API endpoint and model input contract compatible.

  **Must NOT do**:
  - Do not leak API key or raw provider errors containing sensitive metadata.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`git-master`]
    - `git-master`: versionable changes around critical runtime client behavior.
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: irrelevant.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 11, 12, 13, 15
  - **Blocked By**: 4

  **References**:
  - `src/index.js` (`callZaiApi`) - existing API call implementation to harden.
  - `action.yml` - model/api input defaults that must remain compatible.

  **Acceptance Criteria**:
  - [ ] API calls timeout at configured threshold and return classified error.
  - [ ] Retry logic is bounded and jittered.
  - [ ] Error output to comments/logs is sanitized.

  **QA Scenarios**:
  ```
  Scenario: Transient API failure recovers by retry
    Tool: Bash (node --test)
    Preconditions: mocked API returns 502 then 200
    Steps:
      1. Execute client call with retry enabled.
      2. Assert second attempt succeeds.
      3. Assert retry count <= max.
    Expected Result: success after bounded retry.
    Evidence: .sisyphus/evidence/task-8-retry-success.txt

  Scenario: Timeout path returns safe error
    Tool: Bash (node --test)
    Preconditions: mocked slow API beyond timeout
    Steps:
      1. Execute client call.
      2. Assert timeout error category returned.
      3. Assert error message excludes secrets.
    Expected Result: deterministic sanitized timeout response.
    Evidence: .sisyphus/evidence/task-8-timeout-error.txt
  ```

  **Commit**: YES
  - Message: `fix(api): add timeout retry and sanitized errors`
  - Files: `src/*api*`, tests
  - Pre-commit: `node --test`

- [ ] 9. Add idempotent comment/reaction + thread reply utility layer

  **What to do**:
  - Generalize marker-based upsert for top-level and thread replies.
  - Add reaction lifecycle helpers for received/in-progress/success/failure feedback.
  - Enforce no duplicate bot comments for same command execution key.

  **Must NOT do**:
  - Do not spam PR with multiple progress comments per single command.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: keeps response-layer changes traceable.
  - **Skills Evaluated but Omitted**:
    - `playwright`: no browser checks.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 11, 12, 13, 14, 15
  - **Blocked By**: 7

  **References**:
  - `src/index.js` (existing `COMMENT_MARKER` + upsert logic) - baseline behavior to preserve.
  - `ZAI-BOT-FEATURES.md` - threaded replies and emoji feedback requirements.

  **Acceptance Criteria**:
  - [ ] Existing marker-upsert remains stable for PR auto-review.
  - [ ] Command replies use thread reply when parent comment is available.
  - [ ] Reaction updates reflect lifecycle state transitions.

  **QA Scenarios**:
  ```
  Scenario: Existing marker comment is updated, not duplicated
    Tool: Bash (node --test)
    Preconditions: existing comment fixture with marker
    Steps:
      1. Execute upsert helper with new content.
      2. Assert PATCH path used, not POST.
    Expected Result: single updated comment.
    Evidence: .sisyphus/evidence/task-9-upsert-update.txt

  Scenario: Missing parent thread falls back safely
    Tool: Bash (node --test)
    Preconditions: invalid/missing parent comment id
    Steps:
      1. Attempt threaded reply.
      2. Assert fallback to top-level comment.
    Expected Result: response still posted once without crash.
    Evidence: .sisyphus/evidence/task-9-thread-fallback.txt
  ```

  **Commit**: YES
  - Message: `feat(comments): add thread-safe upsert and reactions`
  - Files: `src/*comments*`, tests
  - Pre-commit: `node --test`

- [ ] 10. Implement structured logging and error taxonomy baseline

  **What to do**:
  - Define event correlation IDs and standardized log fields.
  - Categorize errors: auth, validation, provider, rate-limit, timeout, internal.
  - Ensure user-visible messages map to sanitized internal categories.

  **Must NOT do**:
  - Do not log secrets, raw tokens, or full untrusted payload bodies.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`git-master`]
    - `git-master`: controlled rollout for cross-cutting observability changes.
  - **Skills Evaluated but Omitted**:
    - `frontend-design`: irrelevant.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 15, 16, 17
  - **Blocked By**: 7

  **References**:
  - `src/index.js` (`core.info`, `core.warning`, `core.setFailed`) - existing logging/error surfaces.
  - `README.md` - troubleshooting section update target.

  **Acceptance Criteria**:
  - [ ] All command executions emit correlation ID and command type.
  - [ ] Error categories map to deterministic safe user messages.
  - [ ] Sensitive fields are redacted consistently.

  **QA Scenarios**:
  ```
  Scenario: Successful command emits structured log fields
    Tool: Bash (node --test)
    Preconditions: valid command fixture
    Steps:
      1. Execute handler.
      2. Assert logs include eventId, prNumber, command, outcome.
    Expected Result: structured logs for success path.
    Evidence: .sisyphus/evidence/task-10-structured-success-log.txt

  Scenario: Provider error emits sanitized category log
    Tool: Bash (node --test)
    Preconditions: mocked provider failure
    Steps:
      1. Execute handler path to force provider error.
      2. Assert log category `provider_error` and redacted message.
    Expected Result: no secret leakage in logs.
    Evidence: .sisyphus/evidence/task-10-provider-error-log.txt
  ```

  **Commit**: YES
  - Message: `chore(observability): standardize logs and error categories`
  - Files: runtime modules + docs
  - Pre-commit: `node --test`

- [x] 11. Implement `/zai ask`, `/zai help`, and mention normalization

  **What to do**:
  - Implement ask/help command handlers with authorization and parser integration.
  - Normalize mention forms (e.g., `@zai-bot explain ...`) into slash-command path.
  - Add deterministic help output listing supported commands and usage.

  **Must NOT do**:
  - Do not bypass auth for mention-based invocation.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: keeps command-surface changes isolated.
  - **Skills Evaluated but Omitted**:
    - `playwright`: not required.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 12-14)
  - **Blocks**: 15
  - **Blocked By**: 6, 7, 8, 9

  **References**:
  - `ZAI-BOT-FEATURES.md` - ask/help and mention UX requirements.
  - `src/index.js` - current response formatting style.

  **Acceptance Criteria**:
  - [ ] `/zai help` returns command list and syntax.
  - [ ] `/zai ask <question>` executes provider call with bounded context.
  - [ ] Mention format maps to identical command logic.

  **QA Scenarios**:
  ```
  Scenario: Ask command returns answer in-thread
    Tool: Bash (node --test)
    Preconditions: authorized commenter fixture
    Steps:
      1. Submit `/zai ask explain this function` fixture.
      2. Assert handler dispatches ask and posts threaded reply.
    Expected Result: one authorized ask response.
    Evidence: .sisyphus/evidence/task-11-ask-success.txt

  Scenario: Empty ask input returns usage error
    Tool: Bash (node --test)
    Preconditions: authorized commenter fixture
    Steps:
      1. Submit `/zai ask` without arguments.
      2. Assert safe usage hint message returned.
    Expected Result: no provider call when args missing.
    Evidence: .sisyphus/evidence/task-11-ask-empty.txt
  ```

  **Commit**: YES
  - Message: `feat(commands): implement ask help and mention normalization`
  - Files: command handlers + tests
  - Pre-commit: `node --test`

- [x] 12. Implement `/zai review` and `/zai explain <lines>` handlers

  **What to do**:
  - Implement file-targeted review handler and line-range explain handler.
  - Validate file selection and line-range bounds against PR context.
  - Return clear errors for missing files, out-of-range lines, or non-diff context.

  **Must NOT do**:
  - Do not review files outside current PR context without explicit policy support.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: helps isolate more complex context-targeting logic.
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: unrelated.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 15
  - **Blocked By**: 6, 7, 8, 9

  **References**:
  - `ZAI-BOT-FEATURES.md` - review and line-range explain requirements.
  - `src/index.js` (`getChangedFiles`, `buildPrompt`) - context retrieval baseline.

  **Acceptance Criteria**:
  - [ ] `/zai review <path>` uses PR-changed file context only.
  - [ ] `/zai explain a-b` validates numeric and ordered bounds.
  - [ ] Error responses are deterministic and sanitized.

  **QA Scenarios**:
  ```
  Scenario: Review command targets valid changed file
    Tool: Bash (node --test)
    Preconditions: PR fixture with changed file path
    Steps:
      1. Submit `/zai review src/index.js`.
      2. Assert targeted context includes only requested changed file.
    Expected Result: focused review response.
    Evidence: .sisyphus/evidence/task-12-review-targeted.txt

  Scenario: Explain command rejects out-of-range bounds
    Tool: Bash (node --test)
    Preconditions: range exceeds file diff lines
    Steps:
      1. Submit `/zai explain 999-1200`.
      2. Assert validation error and no provider request.
    Expected Result: safe failure for invalid range.
    Evidence: .sisyphus/evidence/task-12-range-invalid.txt
  ```

  **Commit**: YES
  - Message: `feat(commands): add review and explain handlers`
  - Files: handlers + context utilities + tests
  - Pre-commit: `node --test`

- [x] 13. Implement `/zai suggest` and `/zai compare` handlers

  **What to do**:
  - Add suggestion handler for prompt-guided improvements over current diff context.
  - Add compare handler to evaluate old vs new changes in PR context.
  - Ensure response formatting uses markdown code fences for clarity.

  **Must NOT do**:
  - Do not execute arbitrary instructions outside code-analysis scope.

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: incremental command additions with consistent commit quality.
  - **Skills Evaluated but Omitted**:
    - `dev-browser`: not needed.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 15
  - **Blocked By**: 6, 7, 8, 9

  **References**:
  - `ZAI-BOT-FEATURES.md` - suggest/compare behavior requirements.
  - `src/index.js` - markdown response style baseline.

  **Acceptance Criteria**:
  - [ ] `/zai suggest <prompt>` returns bounded, formatted suggestions.
  - [ ] `/zai compare` returns old/new comparative reasoning based on PR diff.
  - [ ] Both handlers obey auth, budget, and error taxonomy controls.

  **QA Scenarios**:
  ```
  Scenario: Suggest command returns markdown-formatted guidance
    Tool: Bash (node --test)
    Preconditions: valid suggest input fixture
    Steps:
      1. Submit `/zai suggest better naming`.
      2. Assert response contains structured markdown sections/code blocks.
    Expected Result: deterministic formatted suggestion output.
    Evidence: .sisyphus/evidence/task-13-suggest-success.txt

  Scenario: Compare command handles missing prior context
    Tool: Bash (node --test)
    Preconditions: compare fixture lacking baseline diff segment
    Steps:
      1. Submit `/zai compare` with insufficient context.
      2. Assert safe message requesting required context.
    Expected Result: graceful degraded response.
    Evidence: .sisyphus/evidence/task-13-compare-missing-context.txt
  ```

  **Commit**: YES
  - Message: `feat(commands): add suggest and compare handlers`
  - Files: handlers + tests
  - Pre-commit: `node --test`

- [x] 14. Implement conversation continuity state model

  **What to do**:
  - Define lightweight continuity strategy for PR thread context (e.g., marker metadata or compact state payload).
  - Preserve continuity across repeated commands in same PR/thread without external database.
  - Add bounded state size and versioning for safe evolution.

  **Must NOT do**:
  - Do not add persistent external storage in this scope.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`git-master`]
    - `git-master`: helps maintain strict scope and reversible state-format changes.
  - **Skills Evaluated but Omitted**:
    - `playwright`: not applicable.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 15
  - **Blocked By**: 7, 9

  **References**:
  - `ZAI-BOT-FEATURES.md` - conversation continuity requirement.
  - `src/index.js` - existing marker strategy for comment idempotency.

  **Acceptance Criteria**:
  - [ ] Continuity state is bounded, versioned, and parseable.
  - [ ] Repeated commands in same thread can reuse relevant context safely.
  - [ ] Corrupted/unknown state fails gracefully without crashes.

  **QA Scenarios**:
  ```
  Scenario: Follow-up command reuses previous thread context
    Tool: Bash (node --test)
    Preconditions: thread with existing continuity metadata
    Steps:
      1. Execute first command fixture and store state.
      2. Execute follow-up command in same thread.
      3. Assert continuity metadata is read and applied.
    Expected Result: context continuity works for follow-up.
    Evidence: .sisyphus/evidence/task-14-continuity-followup.txt

  Scenario: Corrupted continuity state is handled safely
    Tool: Bash (node --test)
    Preconditions: malformed continuity payload
    Steps:
      1. Execute command with corrupted metadata.
      2. Assert fallback to fresh context and warning log.
    Expected Result: no crash, deterministic fallback.
    Evidence: .sisyphus/evidence/task-14-corrupt-state.txt
  ```

  **Commit**: YES
  - Message: `feat(context): add bounded thread continuity state`
  - Files: context/state utilities + tests
  - Pre-commit: `node --test`

- [x] 15. Build end-to-end event+command integration test suite

  **What to do**:
  - Add end-to-end integration tests covering PR auto-review and all slash commands.
  - Validate complete pipeline: event -> auth -> parse -> context -> provider -> comment/reaction.
  - Include deterministic fixtures for success and failure paths.

  **Must NOT do**:
  - Do not rely solely on unit tests for final readiness.

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: [`git-master`]
    - `git-master`: keeps large test additions isolated by concern.
  - **Skills Evaluated but Omitted**:
    - `frontend-design`: no UI target.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4
  - **Blocks**: 16, 17, F1-F4
  - **Blocked By**: 1, 5, 7, 8, 9, 11, 12, 13, 14

  **References**:
  - `src/index.js` - current orchestration baseline.
  - `ZAI-BOT-FEATURES.md` - full command/event acceptance surface.
  - `.github/workflows/code-review.yml` - integration trigger expectations.

  **Acceptance Criteria**:
  - [ ] Integration tests cover PR auto-review and each `/zai` command.
  - [ ] Negative tests cover unauthorized, malformed, and rate/budget failures.
  - [ ] CI can run integration suite non-interactively.

  **QA Scenarios**:
  ```
  Scenario: Full happy-path pipeline passes for all commands
    Tool: Bash
    Preconditions: integration suite available
    Steps:
      1. Run `node --test tests/integration`.
      2. Assert all command and PR flow suites pass.
    Expected Result: green end-to-end matrix.
    Evidence: .sisyphus/evidence/task-15-integration-happy.txt

  Scenario: Unauthorized command fails at auth gate in e2e
    Tool: Bash
    Preconditions: non-collaborator integration fixture
    Steps:
      1. Run unauthorized command integration test.
      2. Assert no provider call and safe reject response.
    Expected Result: authorization enforced end-to-end.
    Evidence: .sisyphus/evidence/task-15-integration-unauthorized.txt
  ```

  **Commit**: YES
  - Message: `test(integration): cover event and command pipelines`
  - Files: integration tests + fixtures
  - Pre-commit: `node --test`

- [ ] 16. Add DevSecOps hardening gates in CI

  **What to do**:
  - Add CI jobs for build, tests, dependency audit, and dist-drift check.
  - Add lint/type/static checks as feasible for repo conventions.
  - Enforce workflow-level least-privilege and controlled failure handling.

  **Must NOT do**:
  - Do not bypass failing security checks in default branch workflow.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: [`git-master`]
    - `git-master`: safer handling for CI/pipeline changes.
  - **Skills Evaluated but Omitted**:
    - `playwright`: not necessary for CI hardening.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4 (with Task 17)
  - **Blocks**: F2, F4
  - **Blocked By**: 2, 5, 10, 15

  **References**:
  - `.github/workflows/code-review.yml` - existing workflow baseline.
  - `package.json` - command source of truth.
  - `CONTRIBUTING.md` - release/build policy requiring dist artifact discipline.

  **Acceptance Criteria**:
  - [ ] CI fails on test/build/security audit failures.
  - [ ] CI fails when `dist/` drift is detected after build.
  - [ ] Required checks are documented for protected branches.

  **QA Scenarios**:
  ```
  Scenario: CI pipeline passes with compliant changes
    Tool: Bash
    Preconditions: valid branch changes
    Steps:
      1. Run CI-equivalent local command chain.
      2. Assert build/test/audit all pass.
    Expected Result: all gates green.
    Evidence: .sisyphus/evidence/task-16-ci-green.txt

  Scenario: Dist drift check fails when dist is stale
    Tool: Bash
    Preconditions: source modified without rebuild
    Steps:
      1. Run build + drift assertion command.
      2. Assert failure on uncommitted dist differences.
    Expected Result: CI blocks stale dist artifacts.
    Evidence: .sisyphus/evidence/task-16-dist-drift.txt
  ```

  **Commit**: YES
  - Message: `chore(ci): enforce security and dist drift gates`
  - Files: workflow + scripts/docs
  - Pre-commit: `node --test && npm run build`

- [ ] 17. Finalize release process, runbook, and senior-approval checklist

  **What to do**:
  - Update release workflow docs for semver tags, changelog expectations, and rollback steps.
  - Add explicit senior-review checklist sections for JS, DevOps, and DevSecOps approval.
  - Document operational playbooks for rate-limit events, provider downtime, and auth denials.

  **Must NOT do**:
  - Do not leave release/rollback steps implicit.

  **Recommended Agent Profile**:
  - **Category**: `writing`
  - **Skills**: [`git-master`]
    - `git-master`: keeps release-doc changes clean and reviewable.
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: irrelevant.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 4
  - **Blocks**: F1, F3
  - **Blocked By**: 10, 15

  **References**:
  - `CONTRIBUTING.md` - existing release/build guidance.
  - `README.md` - user-facing command and setup docs.
  - `action.yml` - public inputs and behavior contract.

  **Acceptance Criteria**:
  - [ ] Release and rollback runbook is complete and executable.
  - [ ] Senior approval checklist explicitly maps to implemented controls.
  - [ ] User docs accurately describe command behavior and security boundaries.

  **QA Scenarios**:
  ```
  Scenario: Release runbook commands execute end-to-end in dry-run
    Tool: Bash
    Preconditions: clean branch with release candidate tag plan
    Steps:
      1. Execute documented release dry-run commands.
      2. Assert each step completes without undocumented prerequisites.
    Expected Result: runbook is executable as written.
    Evidence: .sisyphus/evidence/task-17-release-dryrun.txt

  Scenario: Approval checklist detects missing mandatory control
    Tool: Bash
    Preconditions: temporary checklist validation script
    Steps:
      1. Run checklist validator with one control intentionally missing.
      2. Assert checklist marks release not-ready.
    Expected Result: gating checklist blocks incomplete release.
    Evidence: .sisyphus/evidence/task-17-checklist-gate.txt
  ```

  **Commit**: YES
  - Message: `docs(release): add runbook and senior approval checklist`
  - Files: `README.md`, `CONTRIBUTING.md`, release docs
  - Pre-commit: `node --test && npm run build`

---

## Final Verification Wave (MANDATORY - after ALL implementation tasks)

- [ ] F1. **Plan Compliance Audit** - `oracle`
  Verify all must-have requirements, must-not-have exclusions, and evidence files from each task.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT`

- [ ] F2. **Code Quality Review** - `unspecified-high`
  Run build/lint/test/security checks and inspect changed files for unsafe patterns and low-quality artifacts.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N/N] | VERDICT`

- [ ] F3. **Real QA Replay** - `unspecified-high`
  Replay all QA scenarios exactly as specified, including negative cases and evidence validation.
  Output: `Scenarios [N/N] | Integration [N/N] | Edge Cases [N] | VERDICT`

- [ ] F4. **Scope Fidelity Check** - `deep`
  Validate all changes map 1:1 to tasks and no unplanned scope was introduced.
  Output: `Tasks [N/N] | Creep [NONE/N] | VERDICT`

---

## Commit Strategy

- Group commits by wave; each commit must be atomic and reversible.
- Conventional commit format enforced: `type(scope): description`.
- Dist artifact rule enforced for releases: source + rebuilt `dist/` committed together.

---

## Success Criteria

### Verification Commands
```bash
npm install
npm run build
node --test
```

### Final Checklist
- [ ] All must-have controls implemented and evidenced
- [ ] All must-not-have violations absent
- [ ] Command authorization and parsing controls validated
- [ ] Retry/timeout/rate/token controls validated
- [ ] Release-readiness checks pass
