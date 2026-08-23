---
type: Contract
title: Agent tool-calling loop
description: The provider-neutral agent runner that drives Z.ai chat completions in a bounded tool-calling loop — iteration, call, cumulative retrieval, and absolute-duration budgets with protocol validation, safe tool errors, and a time-reserve finalization mode.
source_paths:
  - poc/workers/shared/agent/runner.js
  - poc/workers/shared/agent/limits.js
  - poc/workers/shared/agent/errors.js
  - poc/workers/zai-heavy-worker/src/handlers/review.js
confidence: observed
status: current
tags:
  - contracts
  - llm
  - agent
---

# Agent tool-calling loop

`createAgentRunner()` (`shared/agent/runner.js`) turns a single-shot LLM call
into a bounded conversation: the model may answer with `tool_calls`, each is
executed against a tool registry, results are appended as `tool` messages,
and the loop continues until the model produces final text or a budget is
exhausted.

# Loop protocol

Each iteration:

1. Check the wall-clock budget → `timed_out` if exceeded. When the remaining
   duration is below `finalizationReserveMs`, enter finalization mode instead:
   append a trusted instruction to stop retrieving context and request final
   Markdown with no tools.
2. Call `llmClient.chat({ apiKey, model, messages, tools, timeoutMs,
   deadlineAt })` with
   an immutable copy of the conversation (the client must observe this
   iteration's sequence, not the array extended after tool execution).
   `deadlineAt` is absolute: Z.ai's retry/backoff loop may not start an attempt
   or sleep beyond it.
3. Validate the assistant message (role, `tool_calls` array shape, ids,
   JSON-string arguments) — protocol violations fail with
   `AGENT_PROTOCOL_ERROR` rather than crash.
4. No tool calls → **completed**, the assistant text is the result.
5. Execute all calls of the iteration **in parallel**; each result is a
   `tool` message `{ ok: true, data }` or `{ ok: false, error: { code, message } }`
   — tool errors become information the model can react to, never a thrown
   exception that kills the run.
   An identical tool name and argument object is retrieved only once per run.
   Later requests receive a safe `DUPLICATE_TOOL_REQUEST` response that directs
   the model to the earlier result already in the conversation.
   If the time reserve starts after the model requested tools, every pending
   call receives a safe `FINALIZATION_REQUIRED` tool response; no registry
   operation runs and the next request has no tool definitions.

# Budgets

Default limits (`shared/agent/limits.js`, overridable per run):

| Limit | Default |
| --- | --- |
| `maxIterations` | 10 |
| `maxToolCalls` (total) | 30 |
| `maxToolCallsPerIteration` | 10 |
| `maxRetrievedBytes` (accepted UTF-8 tool-result data) | 524288 (512 KiB) |
| `maxRunDurationMs` | 300000 (5 min) |
| `maxLlmRequestDurationMs` | 30000 |
| `finalizationReserveMs` | 40000 |

Exceeding a budget returns a typed terminal status (`max_iterations`,
`max_tool_calls`, `max_retrieved_bytes`, `timed_out`) — distinct from `failed`, which is reserved
for provider/protocol errors.

When a tool result would exceed `maxRetrievedBytes`, the current turn receives
one safe `TOOL_BUDGET_EXCEEDED` tool response so the model can finish with its
existing evidence. A subsequent tool-requesting turn terminates as
`max_retrieved_bytes`; this prevents an unbounded error loop.

`/zai review` uses a stricter but larger workflow-specific profile:
8 iterations, 50 total calls, 7 calls per iteration, 256 KiB accepted
tool-result data, a five-minute absolute deadline, and a 40-second
finalization reserve. The reserve keeps enough wall time for a final
no-tools analysis and result publication rather than spending the end of a run
on additional retrieval.
When more than one limit is encountered, the result retains every applicable
`limitReasons` value so the GitHub failure notice can explain all safe,
actionable causes.

# Run result

`{ status, messages, usage, iterations, toolCalls, successfulToolCalls,
failedToolCalls, duplicateToolCalls, executedToolCalls, reviewedDiffPaths,
finalizedWithAvailableEvidence, finalizationReason,
finalizationStartedAtRemainingMs, llmRequests, llmAttempts, llmTimeouts,
retrievedBytes, retrievalBudgetExceeded, limitReasons, conversationBytes,
durationMs, response? }`
— the run transcript is returned so callers can log and inspect agent
behavior. `reviewedDiffPaths` contains only successful `get_diff` results that
were accepted into the model context, which makes it suitable for the
server-generated review evidence metadata.

# Relationships

- Drives [LLM command execution](/workflows/llm-command-execution.md) in
  review mode, bound to the [Context Tools](/contracts/agent-context-tools.md)
  registry.
- Transport is the shared Z.ai `chat()` client with per-attempt retry and
  progressive timeouts; runner-level failures map to the sanitized
  categories of the provider client.
- Terminal statuses feed the `llm_failed` degradation path — raw provider
  errors never reach GitHub comments.
