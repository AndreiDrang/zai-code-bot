---
type: Workflow
title: LLM command execution
description: The shared runner that executes /zai review and /zai describe — config, context guards, Z.ai call (direct or agent-mode with tools), R2 result persistence, and marker-idempotent comment publication.
source_paths:
  - poc/workers/shared/llm-command-runner.js
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
  → system+user prompt → Z.ai (direct call OR AgentRunner with tools)
  → persist result to /context/{command}.md (overwrite, best-effort)
  → marker-idempotent comment
```

## review — agent mode

`/zai review` is an **agentic** review. The prompt carries the inexpensive
snapshot context: PR metadata, description, commits, conversation, and the
changed-file map — **not** the diff. Diffs and source files are fetched
lazily through the seven [Context Tools](/contracts/agent-context-tools.md)
driven by the [Agent tool-calling loop](/contracts/agent-runner.md):
`list_changed_files`, `get_diff`, `get_file`, `get_file_range`,
`get_description`, `get_commits`, `get_comments`.

- The no-context guard for agent mode requires a non-empty changed-file list
  (not a diff string).
- Only `get_file`/`get_file_range` touch GitHub live (fetching repository
  content at the immutable PR head); everything else reads the gathered
  snapshot.
- The result is the agent's final Markdown (Summary / severity-prefixed
  Findings / Notes), stored at `context/review.md` and published as the
  marker-owned review comment.
- A matching-head [PR summary](/workflows/pr-summary-job.md) is injected as
  bounded background (`summary` ≤ ~8% of the context budget).

## describe — direct mode

`/zai describe` synthesizes a PR description from commit messages (gathered
`commits.json`, ≤8000 chars, live GitHub commits as fallback) with a direct
Z.ai call, then replaces only the marker-delimited bot section of the PR body
(`zai-description-start`/`zai-description-end`) and posts a status comment.
The result is also stored at `context/describe.md`.

## Degradations (guards)

| Guard | Result | Job status |
| --- | --- | --- |
| No reviewable context (agent: empty file list; direct: no diff) | Notice comment "nothing to {command}" | `no_diff` (succeeds) |
| `ZAI_API_KEY` unset | Context-aware notice comment | `no_api_key` (succeeds) |
| Z.ai/agent failure | Notice comment with the error category, retryable via `/zai {command}` | `llm_failed` |

Provider failures never expose raw provider errors in comments — only a
sanitized category name. The Z.ai client adds per-attempt retry with
progressive timeouts (100% → 67% → 50% → 33%, 10s floor) and error
categorization (auth / validation / provider / rate-limit / timeout /
internal).

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
