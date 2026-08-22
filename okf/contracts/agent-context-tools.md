---
type: Contract
title: Agent context tools
description: Seven read-only LLM tools with strict JSON schemas exposed over one immutable PR snapshot through the Context Service DTO layer — the model's only channel for large context.
source_paths:
  - poc/workers/shared/context-tools/registry.js
  - poc/workers/shared/context-tools/schemas.js
  - poc/workers/shared/context-tools/handlers.js
  - poc/workers/shared/context/context-service.js
  - poc/workers/shared/context/context-limits.js
  - poc/workers/shared/context/context-errors.js
  - poc/workers/shared/prompts/context-policy.js
  - poc/workers/shared/github.js
confidence: observed
status: current
tags:
  - contracts
  - llm
  - tools
---

# Agent context tools

Agent-mode workflows do **not** receive the aggregate diff in their prompt.
Instead the model pulls exactly what it needs through seven read-only tools
bound to one immutable PR snapshot. Definitions live provider-neutrally in
`shared/context-tools/schemas.js` and are converted to OpenAI
`function`-style tools via `toOpenAiToolDefinitions()`.

# Tool surface

| Tool | Reads | Bound |
| --- | --- | --- |
| `list_changed_files` | snapshot files index (path, status, additions, deletions, binary) | ≤500 files, optional `pathPrefix` |
| `get_diff` | one stored per-file patch | result ≤100 KiB |
| `get_file` | **live GitHub** file content at the immutable PR head | source ≤5 MiB, result ≤100 KiB |
| `get_file_range` | bounded inclusive line range of a head file (via `get_file`) | ≤500 lines, result ≤100 KiB |
| `get_description` | PR title + description slice | ≤50 KiB |
| `get_commits` | commits slice (full messages) | ≤30 |
| `get_comments` | issue + review comments, optional `path` filter | ≤50 |

Default result bounds live in `shared/context/context-limits.js`
(`DEFAULT_CONTEXT_DIFF_RESULT_BYTES` / `DEFAULT_CONTEXT_FILE_RESULT_BYTES`
= 100 KiB). Oversized results return `{ truncated: true, content: null, bytes }`
rather than partial text.

# Context Service

`createContextService()` (`shared/context/context-service.js`) is the single
application-facing reader of the V2 snapshot. It:

- memoizes the manifest + files index per instance;
- validates `manifest.headSha` against an optional `expectedHeadSha`,
  returning `stale` status instead of mixing heads;
- projects compact DTOs (changed-file DTO, PR metadata DTO) — raw storage
  shapes never reach prompts or tools;
- normalizes and defensively validates every repository path
  (`normalizeRepositoryPath`: no absolute paths, `..`, or NUL) before it can
  become part of an R2 key;
- reconstructs a bounded unified-diff view (`getCombinedDiff`) for
  non-agent prompt builders — whole files that exceed the budget are
  `omittedPaths`, never truncated mid-patch.

# Failure modes

Tool errors are normalized as typed `contextError` codes
(`INVALID_PATH`, `INVALID_REVISION`, `INVALID_LINE_RANGE`,
`SOURCE_UNAVAILABLE`, `FILE_NOT_FOUND`, `FILE_TOO_LARGE`) which the
[Agent tool-calling loop](/contracts/agent-runner.md) converts into safe
tool messages the model can react to.

# Relationships

- Executed by the [Agent tool-calling loop](/contracts/agent-runner.md)
  during [LLM command execution](/workflows/llm-command-execution.md)
  (review, describe, and internal PR summary).
- Reads the snapshot written by the
  [PR-context gather pipeline](/workflows/pr-context-pipeline.md);
  `get_file`/`get_file_range` are the only live-GitHub readers.

# LLM-facing descriptions

  Tool definitions state each tool's semantic purpose, when it is useful, and
  when a narrower or different tool is preferable. They do not expose R2/D1/KV,
  artifact keys, checksums, or provider implementation. Shared retrieval policy
  belongs in the workflow's system prompt, while a definition gives only local
  guidance for that tool.
