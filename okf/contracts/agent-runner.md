---
type: Contract
title: Agent tool-calling loop
description: The provider-neutral agent runner that drives Z.ai chat completions in a bounded tool-calling loop — iteration, call, and duration budgets with protocol validation and safe tool errors.
source_paths:
  - poc/workers/shared/agent/runner.js
  - poc/workers/shared/agent/limits.js
  - poc/workers/shared/agent/errors.js
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

1. Check the wall-clock budget → `timed_out` if exceeded.
2. Call `llmClient.chat({ apiKey, model, messages, tools, timeoutMs })` with
   an immutable copy of the conversation (the client must observe this
   iteration's sequence, not the array extended after tool execution).
3. Validate the assistant message (role, `tool_calls` array shape, ids,
   JSON-string arguments) — protocol violations fail with
   `AGENT_PROTOCOL_ERROR` rather than crash.
4. No tool calls → **completed**, the assistant text is the result.
5. Execute all calls of the iteration **in parallel**; each result is a
   `tool` message `{ ok: true, data }` or `{ ok: false, error: { code, message } }`
   — tool errors become information the model can react to, never a thrown
   exception that kills the run.

# Budgets

Default limits (`shared/agent/limits.js`, overridable per run):

| Limit | Default |
| --- | --- |
| `maxIterations` | 10 |
| `maxToolCalls` (total) | 30 |
| `maxToolCallsPerIteration` | 10 |
| `maxRunDurationMs` | 120000 (2 min) |
| `maxLlmRequestDurationMs` | 30000 |

Exceeding a budget returns a typed terminal status (`max_iterations`,
`max_tool_calls`, `timed_out`) — distinct from `failed`, which is reserved
for provider/protocol errors.

# Run result

`{ status, messages, usage, iterations, toolCalls, durationMs, response? }`
— the run transcript is returned so callers can log and inspect agent
behavior (`agentIterations` / `agentToolCalls` surface in review job
results).

# Relationships

- Drives [LLM command execution](/workflows/llm-command-execution.md) in
  review mode, bound to the [Context Tools](/contracts/agent-context-tools.md)
  registry.
- Transport is the shared Z.ai `chat()` client with per-attempt retry and
  progressive timeouts; runner-level failures map to the sanitized
  categories of the provider client.
- Terminal statuses feed the `llm_failed` degradation path — raw provider
  errors never reach GitHub comments.
