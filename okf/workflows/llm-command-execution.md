---
type: Workflow
title: LLM command execution
description: The shared runner that executes /zai review and /zai describe — config, context guards, bounded Z.ai agent calls with tools, R2 result persistence, and marker-idempotent comment publication.
source_paths:
  - poc/workers/shared/llm-command-runner.js
  - poc/workers/shared/prompts/context-policy.js
  - poc/workers/shared/prompts/review.js
  - poc/workers/zai-heavy-worker/generated/prompts.js
  - poc/workers/zai-heavy-worker/src/handlers/review.js
  - poc/workers/zai-heavy-worker/src/handlers/describe.js
  - poc/workers/shared/zai-client.js
confidence: observed
status: current
tags:
  - workflow
  - llm
  - commands
---

# LLM command execution

Both user-facing LLM commands run as durable jobs on the heavy worker through
one shared lifecycle, `runLlmCommand()`
(`shared/llm-command-runner.js`). Each handler supplies only its identity
(command name, system prompt, user-prompt builder, marker, emoji, prompt
version) — the runner owns everything else:

```text
config → load V2 context slices → no-context guard → API-key guard
  → system+user prompt → AgentRunner + Z.ai tools
  → persist result to /context/{command}.md (overwrite, best-effort)
  → marker-idempotent comment
```

The model is selected at call time: `env.ZAI_MODEL` with a `glm-5.2`
fallback in code — both wrangler configs currently deploy `glm-5.3`, so the
fallback is not the effective model in production.

## review — agent mode

`/zai review` is an **agentic** review. The prompt carries the inexpensive
snapshot context: PR metadata, description, commits, conversation, and the
changed-file map with status, line-change counts, and explicit `binary: true`
or `binary: false` flags — **not** the diff. Summary and describe layouts
label only binary files to avoid unnecessary noise. Diffs and source files are fetched
lazily through the seven [Context Tools](/contracts/agent-context-tools.md)
driven by the [Agent tool-calling loop](/contracts/agent-runner.md):
`list_changed_files`, `get_diff`, `get_file`, `get_file_range`,
`get_description`, `get_commits`, `get_comments`.

The review workflow composes three independent inputs before it reaches
`AgentRunner`:

1. A static system prompt: reviewer methodology, shared context-retrieval
   policy, untrusted-repository-content policy, and the Markdown output
   contract. The base role prompt is human-authored in
   `prompts/review.txt`, generated into `generated/prompts.js` by
   `scripts/generate-prompts.mjs`, and composed with the shared policies by
   `shared/prompts/review.js`.
2. An untrusted user message containing semantic PR metadata and the gathered
   inexpensive slices. It contains no storage keys, checksums, raw diff, or
   full source.
3. Tool definitions with local semantic descriptions for each capability.

`AgentRunner` does not build or interpret these prompts. It only drives the
LLM ↔ tool protocol and enforces its runtime budgets.

- The no-context guard for agent mode requires a non-empty changed-file list
  (not a diff string).
- Only `get_file`/`get_file_range` touch GitHub live (fetching repository
  content at the immutable PR head); everything else reads the gathered
  snapshot.
- The result is the agent's final Markdown (Summary / severity-prefixed
  Findings / Notes), followed by server-generated `Review metadata`, stored at
  `context/review.md` and published as the marker-owned review comment. The
  metadata reports actual Context Tool executions, accepted per-file diffs, the
  retrieved-context size, and whether time-reserve finalization was used; it is
  not model-generated.
- A matching-head [PR summary](/workflows/pr-summary-job.md) is injected as
  bounded background (`summary` ≤ ~8% of the context budget).
- Review permits up to 50 context-tool calls (at most seven per agent turn)
  and 256 KiB of accepted tool results over a five-minute deadline. At less
  than 40 seconds remaining, or after either retrieval budget is exhausted,
  it disables Context Tools and asks the model to complete the analysis from
  available evidence. A completed review records that finalization reason in
  server-generated metadata; it does not fail merely because its allowed
  retrieval budget was used.

## describe — agent mode

`/zai describe` synthesizes a PR description from the inexpensive snapshot
context (including gathered commits, with live GitHub commits as fallback) and
can retrieve targeted diffs or source through the same AgentRunner and Context
Tools. It replaces only the marker-delimited bot section of the PR body
(`zai-description-start`/`zai-description-end`) and posts a status comment. The
result is also stored at `context/describe.md`.

## Degradations (guards)

| Guard | Result | Job status |
| --- | --- | --- |
| No reviewable context (agent: empty file list; direct: no diff) | Notice comment "nothing to {command}" | `no_diff` (succeeds) |
| `ZAI_API_KEY` unset | Context-aware notice comment | `no_api_key` (succeeds) |
| Retryable Z.ai/agent failure (`timeout`, provider, rate-limit) before the final job attempt | No GitHub notice; throw typed error for Queue backoff | `retryable` |
| Terminal or non-retryable Z.ai/agent failure | Notice comment with a safe, actionable cause | `failed` |

Provider failures never expose raw provider errors in comments — only a
sanitized explanation. Terminal comments distinguish execution, tool-call,
retrieved-context, and investigation limits; timeouts; rate limits; temporary
provider unavailability; rejected credentials or invalid requests; malformed
responses; and internal failures. Where it is safe to do so, the message also
states completed context requests, retrieved bytes, or retry attempts. The Z.ai
client adds per-attempt retry with progressive timeouts (100% → 67% → 50% →
33%; direct calls have a 10s floor) and error categorization (auth / validation
/ provider / rate-limit / timeout / internal). Agent-mode calls cap each
attempt and backoff at AgentRunner's absolute deadline, so neither can exceed
the run budget.

## Command-result persistence

Results are written (best-effort — a persist failure must not lose the
comment) to `v2/prs/{repo}/{pr}/context/{command}.md`: one object per
command per PR, overwrite semantics, no D1 index, riding the `v2/prs/`
lifecycle retention. `readCommandResult()` is the paired reader.

## Relationships

- Runs through the [job lifecycle](/state/job-lifecycle.md) after
  [command routing](/workflows/command-routing.md); comments follow
  [one-live-comment publication](/state/comment-publication.md) and the
  [comment footer](/rules/comment-footer.md).
- Review agent mode is powered by the [Agent tool-calling loop](/contracts/agent-runner.md)
  and [Context Tools](/contracts/agent-context-tools.md) over the
  [PR-context gather pipeline](/workflows/pr-context-pipeline.md) snapshot.
