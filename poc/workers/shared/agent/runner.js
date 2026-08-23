import { AgentProtocolError, toSafeToolError } from './errors.js';
import { resolveAgentLimits } from './limits.js';

export function createAgentRunner({
  llmClient,
  toolRegistry,
  logger,
  limits,
  now = () => Date.now(),
}) {
  if (!llmClient?.chat) throw new TypeError('AgentRunner requires an llmClient with chat()');
  if (!toolRegistry?.execute)
    throw new TypeError('AgentRunner requires a toolRegistry with execute()');

  const resolvedLimits = resolveAgentLimits(limits);

  async function run({ apiKey, model, messages, tools, runId }) {
    const conversation = Array.isArray(messages) ? [...messages] : [];
    const startedAt = now();
    const deadlineAt = startedAt + resolvedLimits.maxRunDurationMs;
    let iterations = 0;
    let toolCalls = 0;
    let usage = null;
    let llmRequests = 0;
    let llmAttempts = 0;
    let llmTimeouts = 0;
    let retrievedBytes = 0;
    let retrievalBudgetExceeded = false;
    const toolNames = new Set();
    const requestedToolCallKeys = new Set();
    const limitReasons = new Set();
    let successfulToolCalls = 0;
    let failedToolCalls = 0;
    let duplicateToolCalls = 0;
    const reviewedDiffPaths = [];
    const reviewedDiffPathSet = new Set();
    let finalizedWithAvailableEvidence = false;
    let finalizationReason = null;
    let finalizationStartedAtRemainingMs = null;

    while (true) {
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) {
        return buildResult('timed_out');
      }
      if (remainingMs < resolvedLimits.finalizationReserveMs) enterFinalization(remainingMs);

      let response;
      const requestNumber = ++llmRequests;
      const conversationBytes = jsonByteLength(conversation);
      try {
        response = await llmClient.chat({
          apiKey,
          model,
          // The client/mock must observe this iteration's immutable message
          // sequence, not the array that is extended after tool execution.
          messages: [...conversation],
          tools: finalizedWithAvailableEvidence ? [] : tools,
          timeoutMs: Math.min(remainingMs, resolvedLimits.maxLlmRequestDurationMs),
          deadlineAt,
          onAttempt: (attempt) => {
            llmAttempts += 1;
            if (attempt.category === 'timeout') llmTimeouts += 1;
            logger?.info('Agent LLM attempt completed', {
              runId,
              requestNumber,
              ...attempt,
              conversationMessages: conversation.length,
              conversationBytes,
              retrievedBytes,
            });
          },
        });
      } catch {
        return buildResult('failed', { error: { category: 'provider' } });
      }
      if (!response || typeof response !== 'object') {
        return buildResult('failed', {
          error: { category: 'protocol', code: 'AGENT_PROTOCOL_ERROR' },
        });
      }
      if (!response.success) {
        return buildResult('failed', { error: response.error || { category: 'provider' } });
      }

      const assistant = response.data?.message;
      usage = response.data?.usage || usage;
      try {
        validateAssistantMessage(assistant);
        validateToolCalls(assistant.tool_calls || []);
      } catch (error) {
        return buildResult('failed', {
          error: {
            category: 'protocol',
            code: error?.code || 'AGENT_PROTOCOL_ERROR',
          },
        });
      }
      const calls = assistant.tool_calls || [];

      if (!calls.length) {
        conversation.push(assistant);
        return buildResult('completed', { response: assistant });
      }

      if (
        finalizedWithAvailableEvidence ||
        deadlineAt - now() < resolvedLimits.finalizationReserveMs
      ) {
        enterFinalization(Math.max(0, deadlineAt - now()));
        conversation.push(assistant, ...calls.map((call) => makeFinalizationToolResult(call.id)));
        continue;
      }
      if (calls.length > resolvedLimits.maxToolCallsPerIteration) {
        return buildResult('max_tool_calls');
      }
      if (toolCalls + calls.length > resolvedLimits.maxToolCalls) {
        return buildResult('max_tool_calls');
      }
      if (retrievalBudgetExceeded) {
        return buildResult('max_retrieved_bytes');
      }
      if (iterations >= resolvedLimits.maxIterations) {
        return buildResult('max_iterations');
      }

      iterations += 1;
      toolCalls += calls.length;
      conversation.push(assistant);

      logger?.info('Agent iteration executing tools', {
        runId,
        iteration: iterations,
        toolCalls: calls.length,
        tools: calls.map((call) => call.function.name),
      });
      const toolResults = await Promise.all(
        calls.map((call) => {
          const toolCallKey = createToolCallKey(call);
          if (requestedToolCallKeys.has(toolCallKey)) {
            duplicateToolCalls += 1;
            toolNames.add(call.function.name);
            logger?.info('Agent duplicate tool request skipped', {
              runId,
              iteration: iterations,
              tool: call.function.name,
            });
            return Promise.resolve(makeDuplicateToolResult(call.id));
          }

          requestedToolCallKeys.add(toolCallKey);
          return executeToolCall(call, {
            iteration: iterations,
            runId,
            onComplete: ({ tool, success }) => {
              if (tool) toolNames.add(tool);
              if (success) successfulToolCalls += 1;
              else failedToolCalls += 1;
            },
          }).then((result) => {
            if (!result.success) requestedToolCallKeys.delete(toolCallKey);
            return result;
          });
        }),
      );
      const toolMessages = [];
      for (const toolResult of toolResults) {
        if (
          toolResult.success &&
          retrievedBytes + toolResult.resultBytes > resolvedLimits.maxRetrievedBytes
        ) {
          retrievalBudgetExceeded = true;
          limitReasons.add('max_retrieved_bytes');
          toolMessages.push(
            makeToolMessage(toolResult.toolCallId, {
              ok: false,
              error: {
                code: 'TOOL_BUDGET_EXCEEDED',
                message:
                  'The context retrieval budget for this run has been reached. Continue using the evidence already retrieved.',
              },
            }),
          );
          continue;
        }
        if (toolResult.success) {
          retrievedBytes += toolResult.resultBytes;
          if (toolResult.tool === 'get_diff' && typeof toolResult.args?.path === 'string') {
            if (!reviewedDiffPathSet.has(toolResult.args.path)) {
              reviewedDiffPathSet.add(toolResult.args.path);
              reviewedDiffPaths.push(toolResult.args.path);
            }
          }
        }
        toolMessages.push(toolResult.message);
      }
      conversation.push(...toolMessages);
    }

    function buildResult(status, extra = {}) {
      if (status.startsWith('max_')) limitReasons.add(status);
      const conversationBytes = jsonByteLength(conversation);
      const result = {
        status,
        messages: conversation,
        usage,
        iterations,
        toolCalls,
        usedTools: toolCalls > 0,
        tools: [...toolNames],
        successfulToolCalls,
        failedToolCalls,
        duplicateToolCalls,
        executedToolCalls: successfulToolCalls + failedToolCalls,
        reviewedDiffPaths,
        finalizedWithAvailableEvidence,
        finalizationReason,
        finalizationStartedAtRemainingMs,
        llmRequests,
        llmAttempts,
        llmTimeouts,
        retrievedBytes,
        retrievalBudgetExceeded,
        limitReasons: [...limitReasons],
        conversationBytes,
        durationMs: now() - startedAt,
        ...extra,
      };
      logger?.info('Agent run finished', {
        runId,
        status,
        iterations,
        toolCalls,
        usedTools: result.usedTools,
        tools: result.tools,
        successfulToolCalls,
        failedToolCalls,
        duplicateToolCalls,
        executedToolCalls: successfulToolCalls + failedToolCalls,
        reviewedDiffCount: reviewedDiffPaths.length,
        reviewedDiffPaths,
        finalizedWithAvailableEvidence,
        finalizationReason,
        finalizationStartedAtRemainingMs,
        llmRequests,
        llmAttempts,
        llmTimeouts,
        retrievedBytes,
        retrievalBudgetExceeded,
        limitReasons: result.limitReasons,
        maxIterations: resolvedLimits.maxIterations,
        maxToolCalls: resolvedLimits.maxToolCalls,
        maxToolCallsPerIteration: resolvedLimits.maxToolCallsPerIteration,
        maxRetrievedBytes: resolvedLimits.maxRetrievedBytes,
        conversationBytes,
        durationMs: result.durationMs,
      });
      return result;
    }

    function enterFinalization(remainingMs) {
      if (finalizedWithAvailableEvidence) return;
      finalizedWithAvailableEvidence = true;
      finalizationReason = 'time_reserve';
      finalizationStartedAtRemainingMs = remainingMs;
      conversation.push({
        role: 'system',
        content:
          'The investigation time reserve has started. Do not request or call any more tools. ' +
          'Complete the review now using only the evidence already in this conversation. ' +
          'Do not infer facts about files or diffs that were not retrieved.',
      });
      logger?.info('Agent finalization started', {
        runId,
        reason: finalizationReason,
        remainingMs,
        toolCalls,
        reviewedDiffCount: reviewedDiffPaths.length,
      });
    }
  }

  async function executeToolCall(call, { iteration, runId, onComplete }) {
    const startedAt = now();
    const name = call?.function?.name;
    const toolCallId = call?.id;

    try {
      const rawArguments = call.function.arguments ?? '{}';
      const args = JSON.parse(rawArguments);
      const data = await toolRegistry.execute(name, args);
      const content = { ok: true, data };
      const resultBytes = jsonByteLength(content);
      onComplete?.({ tool: name, success: true });
      logTool('Agent tool completed', {
        runId,
        iteration,
        tool: name,
        toolCallId,
        success: true,
        durationMs: now() - startedAt,
        resultBytes,
      });
      return {
        success: true,
        tool: name,
        args,
        toolCallId,
        resultBytes,
        message: makeToolMessage(toolCallId, content),
      };
    } catch (error) {
      const safeError =
        error instanceof AgentProtocolError
          ? { code: error.code, message: error.message }
          : toSafeToolError(error);
      onComplete?.({ tool: typeof name === 'string' ? name : null, success: false });
      logTool('Agent tool failed', {
        runId,
        iteration,
        tool: typeof name === 'string' ? name : null,
        toolCallId: typeof toolCallId === 'string' ? toolCallId : null,
        success: false,
        errorCode: safeError.code,
        durationMs: now() - startedAt,
      });
      return {
        success: false,
        toolCallId: toolCallId || `invalid-${iteration}`,
        resultBytes: 0,
        message: makeToolMessage(toolCallId || `invalid-${iteration}`, {
          ok: false,
          error: safeError,
        }),
      };
    }
  }

  function logTool(message, data) {
    if (data.success) logger?.info(message, data);
    else logger?.warn(message, data);
  }

  return { run, limits: resolvedLimits };
}

function validateAssistantMessage(message) {
  if (!message || typeof message !== 'object' || message.role !== 'assistant') {
    throw new AgentProtocolError('LLM response does not contain an assistant message.');
  }
  if (message.tool_calls != null && !Array.isArray(message.tool_calls)) {
    throw new AgentProtocolError('LLM tool calls must be an array.');
  }
  if (!message.tool_calls?.length && typeof message.content !== 'string') {
    throw new AgentProtocolError('LLM response does not contain final text or tool calls.');
  }
}

function validateToolCalls(calls) {
  for (const call of calls) {
    if (!call?.id || typeof call.id !== 'string') {
      throw new AgentProtocolError('Tool call is missing an id.');
    }
    if (!call.function?.name || typeof call.function.name !== 'string') {
      throw new AgentProtocolError('Tool call is missing a function name.');
    }
    if (call.function.arguments != null && typeof call.function.arguments !== 'string') {
      throw new AgentProtocolError('Tool call arguments must be a JSON string.');
    }
  }
}

function makeToolMessage(toolCallId, content) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(content),
  };
}

function makeDuplicateToolResult(toolCallId) {
  return {
    success: false,
    toolCallId,
    resultBytes: 0,
    message: makeToolMessage(toolCallId, {
      ok: false,
      error: {
        code: 'DUPLICATE_TOOL_REQUEST',
        message:
          'This exact context request was already completed in this run. Use its earlier result to continue the review.',
      },
    }),
  };
}

function makeFinalizationToolResult(toolCallId) {
  return makeToolMessage(toolCallId, {
    ok: false,
    error: {
      code: 'FINALIZATION_REQUIRED',
      message:
        'The investigation time reserve has started. No more context can be retrieved; finalize using the evidence already available.',
    },
  });
}

function createToolCallKey(call) {
  const name = call.function.name;
  const rawArguments = call.function.arguments ?? '{}';
  try {
    const args = JSON.parse(rawArguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) return `${name}:${rawArguments}`;
    const normalized = Object.fromEntries(
      Object.entries(args).sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey)),
    );
    return `${name}:${JSON.stringify(normalized)}`;
  } catch {
    return `${name}:${rawArguments}`;
  }
}

function jsonByteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}
