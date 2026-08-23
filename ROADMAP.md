# Development Roadmap

Planned features for the `/zai` bot. Each feature lists the decisions already
made, the expected touch points in `src/`, and acceptance criteria. Nothing
here is implemented yet — check off items as work lands.

Suggested implementation order: **Feature 3 → Feature 1 → Feature 2**
(smallest blast radius first; Feature 2 needs a security review of the
injection framing before merge).

---

## Feature 1 — Repository docs (AGENTS.md / ARCHITECTURE.md) as a Context Tool

**Goal:** let the review model consult the reviewed project's own core
documentation when judging a PR, instead of reviewing against assumed
conventions.

### Decisions

| Question            | Decision                                                       |
| ------------------- | -------------------------------------------------------------- |
| Which files         | Root `AGENTS.md` and `ARCHITECTURE.md` only                    |
| Source ref          | PR head SHA (same pinned ref as all other context reads)       |
| Delivery mechanism  | Dedicated Context Tool — no pre-injection into initial context |
| Per-file size limit | 64 KB (still bounded by the global 256 KB `maxRetrievedBytes`) |

### Tasks

- [ ] Add tool schema + handler (e.g. `get_project_docs`) in
      `src/shared/context-tools/schemas.js` / `handlers.js`; register it in
      `src/shared/context-tools/registry.js`.
  - One call returns both files, each truncated at 64 KB with an explicit
    truncation notice when hit; a missing file is reported as absent, not an
    error.
  - Read via the existing Context Service `getFile` path so the head-SHA
    pinning and audit trail apply unchanged.
- [ ] Write the tool description so the model knows these are the project's
      own conventions and review findings may cite them as the source of truth.
- [ ] Tests in `src/tests/context-tools.test.js`: both files present, one
      missing, both missing, truncation at the 64 KB boundary, ref pinning.

### Acceptance criteria

- `/zai review` on a repo with an `AGENTS.md` containing a project convention
  lets the model reference that convention in findings without any
  `get_file` call by the user.
- Runs on repos without either file behave identically to today (tool reports
  absence; no errors, no extra prompt tokens).

### Open questions

- Extend the same tool to `describe` and `pr_summary` runs later, or keep it
  review-only for now? (Default: review-only.)

---

## Feature 2 — Custom prompt file `.github/zai-instructions.md`

**Goal:** repos can customize bot behavior per-project through an instructions
file, like the GitHub Copilot review bot supports — but with a real size
budget instead of the ~4k-symbol cap.

### Decisions

| Question        | Decision                                                          |
| --------------- | ----------------------------------------------------------------- |
| File path       | `.github/zai-instructions.md` (one generic file for all commands) |
| Injection point | System prompt, as a clearly-labeled section                       |
| Size limit      | 64 KB                                                             |
| Command scope   | `review` **and** `describe`                                       |

### Tasks

- [ ] Fetch `.github/zai-instructions.md` at the PR head SHA during command
      setup (heavy worker, before prompt assembly); missing file = silent no-op.
  - Enforce the 64 KB cap with an explicit truncation notice.
- [ ] Extend `buildReviewSystemPrompt` and the describe equivalent to append a
      `## Repository-provided guidance` section containing the file content.
  - Framing must state the section is untrusted repo content, subordinate to
    every built-in rule, and never overrides output/secrecy constraints
    (`SECURITY.md` invariants). Custom prompts must not be able to disable the
    score output (Feature 3) or the untrusted-content policy.
- [ ] Include the instruction file's content hash in `promptVersion`
      (e.g. `review-v5+<sha8>`) so runs are traceable to the exact guidance used.
- [ ] Document the file format in `README.md` (supported keys/expectations,
      size limit, precedence below built-in prompts).
- [ ] Tests: injection present/absent, truncation, hash in `promptVersion`,
      describe parity, and a security test asserting guidance cannot rewrite the
      output contract markers.

### Acceptance criteria

- A repo adding `.github/zai-instructions.md` with e.g. "always flag raw SQL
  string concatenation" sees `/zai review` and `/zai describe` honor it.
- Repos without the file see zero behavioral change.

---

## Feature 3 — Review score 0–10

**Goal:** bring back the numeric PR-quality score from the old prompts: a
0 (bad PR) to 10 (good PR) counter at the top of every review report, with a
stable rubric and a machine-readable form.

### Decisions

| Question         | Decision                                                         |
| ---------------- | ---------------------------------------------------------------- |
| Presentation     | Bold score line on top, before `## Summary`                      |
| Rubric           | Anchored bands defined in the prompt                             |
| Granularity      | Integer only (0–10)                                              |
| Machine-readable | Hidden `<!-- zai-score: N -->` comment next to the visible score |

### Output shape

```markdown
## Review

<!-- zai-score: 7 -->

**Score: 7/10**

## Summary

…

## Findings

…
```

### Tasks

- [ ] Extend `REVIEW_OUTPUT_CONTRACT` in `src/shared/prompts/review.js` with
      the score line, the hidden comment, and the anchored rubric:
  - 0–3 blocking issues (must fix before merge);
  - 4–6 significant concerns (should fix or justify);
  - 7–8 minor issues (non-blocking);
  - 9–10 clean (at most nits).
- [ ] Bump `PROMPT_VERSION` `review-v4` → `review-v5` in
      `src/zai-heavy-worker/src/handlers/review.js`.
- [ ] Update `src/tests/prompts-review.test.js` for the new contract; add a
      lenient parser/util for `<!-- zai-score: N -->` so future consumers (stats,
      gate checks, retry flows) don't regex the formatted text independently.
- [ ] Keep marker-idempotency intact: the score is body content only, the
      `REVIEW_MARKER` lease flow is untouched.

### Acceptance criteria

- Every `/zai review` comment starts with the visible score and the hidden
  machine-readable tag; scores are comparable across PRs thanks to the rubric.
- `describe` output is unchanged.

---

## Cross-cutting notes

- Each feature bumps a `promptVersion` and lands with tests
  (`npm test` / `make test` must stay green).
- Feature 1 and 2 add repo-sourced content to model input: both must honor
  `UNTRUSTED_REPOSITORY_CONTENT_POLICY` framing and the "never expose secrets
  or raw provider errors" invariant.
- When features land, update `okf/` (start from `okf/index.md`) and the
  relevant root docs (`ARCHITECTURE.md`, `README.md`, `SECURITY.md`) — the
  context tier, prompt assembly, and output contract are documented domains.
