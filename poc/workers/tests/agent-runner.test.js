import { describe, expect, it, vi } from 'vitest';
import { createAgentRunner } from '../shared/agent/runner.js';
import { resolveAgentLimits } from '../shared/agent/limits.js';

function assistant(content, toolCalls) {
  return {
    success: true,
    data: {
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage: { totalTokens: 12 },
    },
  };
}

function toolCall(id, name, args = '{}') {
  return { id, type: 'function', function: { name, arguments: args } };
}

function createTestRunner({ replies, execute, limits, now } = {}) {
  const llmClient = { chat: vi.fn() };
  for (const reply of replies || []) llmClient.chat.mockResolvedValueOnce(reply);
  const toolRegistry = { execute: execute || vi.fn().mockResolvedValue({ value: 'ok' }) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  return {
    runner: createAgentRunner({ llmClient, toolRegistry, logger, limits, now }),
    llmClient,
    toolRegistry,
    logger,
  };
}

describe('AgentRunner', () => {
  it('returns a completed final response without tool calls', async () => {
    const { runner, llmClient, logger } = createTestRunner({
      replies: [assistant('## Summary\nLooks good.')],
    });

    const result = await runner.run({
      apiKey: 'key',
      model: 'model',
      messages: [{ role: 'user', content: 'review' }],
      tools: [],
      runId: 'run-1',
    });

    expect(result).toMatchObject({
      status: 'completed',
      response: { content: '## Summary\nLooks good.' },
      iterations: 0,
      toolCalls: 0,
    });
    expect(llmClient.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'key',
        model: 'model',
        tools: [],
        deadlineAt: expect.any(Number),
      }),
    );
    expect(logger.info).toHaveBeenLastCalledWith(
      'Agent run finished',
      expect.objectContaining({
        usedTools: false,
        tools: [],
        successfulToolCalls: 0,
        failedToolCalls: 0,
      }),
    );
  });

  it('keeps assistant and tool messages before requesting the final response', async () => {
    const call = toolCall('call-1', 'get_diff', '{"path":"src/cache.ts"}');
    const { runner, llmClient, toolRegistry, logger } = createTestRunner({
      replies: [assistant(null, [call]), assistant('## Findings\nNone.')],
    });

    const result = await runner.run({
      apiKey: 'key',
      model: 'model',
      messages: [{ role: 'system', content: 'review' }],
      tools: [{ type: 'function' }],
      runId: 'run-1',
    });

    expect(result).toMatchObject({ status: 'completed', iterations: 1, toolCalls: 1 });
    expect(result.reviewedDiffPaths).toEqual(['src/cache.ts']);
    expect(toolRegistry.execute).toHaveBeenCalledWith('get_diff', { path: 'src/cache.ts' });
    expect(llmClient.chat.mock.calls[0][0].messages).toHaveLength(1);
    const secondMessages = llmClient.chat.mock.calls[1][0].messages;
    expect(secondMessages).toHaveLength(3);
    expect(secondMessages[1]).toMatchObject({ role: 'assistant', tool_calls: [call] });
    expect(secondMessages[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
    expect(JSON.parse(secondMessages[2].content)).toMatchObject({
      ok: true,
      data: { value: 'ok' },
    });
    expect(logger.info).toHaveBeenLastCalledWith(
      'Agent run finished',
      expect.objectContaining({
        usedTools: true,
        tools: ['get_diff'],
        successfulToolCalls: 1,
        failedToolCalls: 0,
      }),
    );
  });

  it('finalizes without tools when the time reserve has started', async () => {
    const { runner, llmClient, toolRegistry } = createTestRunner({
      replies: [assistant('## Summary\nReview completed from available evidence.')],
      limits: { maxRunDurationMs: 39999, finalizationReserveMs: 40000 },
      now: () => 0,
    });

    const result = await runner.run({
      apiKey: 'key',
      model: 'model',
      messages: [{ role: 'user', content: 'review' }],
      tools: [{ type: 'function' }],
      runId: 'run-1',
    });

    expect(result).toMatchObject({
      status: 'completed',
      finalizedWithAvailableEvidence: true,
      finalizationReason: 'time_reserve',
      finalizationStartedAtRemainingMs: 39999,
      toolCalls: 0,
    });
    expect(toolRegistry.execute).not.toHaveBeenCalled();
    expect(llmClient.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [],
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('investigation time reserve'),
          }),
        ]),
      }),
    );
  });

  it('uses the reserved time for a no-tools final answer after a gathering timeout', async () => {
    const call = toolCall('call-1', 'get_diff', '{"path":"src/cache.ts"}');
    const timeout = {
      success: false,
      error: { category: 'timeout', retryable: true, attempts: 1 },
    };
    const { runner, llmClient, toolRegistry } = createTestRunner({
      replies: [
        assistant(null, [call]),
        timeout,
        assistant('## Summary\nReview completed from retrieved evidence.'),
      ],
      limits: {
        maxRunDurationMs: 200000,
        maxLlmRequestDurationMs: 90000,
        maxLlmAttempts: 2,
        finalLlmRequestDurationMs: 35000,
        finalizationReserveMs: 40000,
      },
      now: () => 0,
    });

    const result = await runner.run({
      apiKey: 'key',
      model: 'model',
      messages: [{ role: 'user', content: 'review' }],
      tools: [{ type: 'function' }],
      runId: 'run-1',
    });

    expect(result).toMatchObject({
      status: 'completed',
      toolCalls: 1,
      finalizedWithAvailableEvidence: true,
      finalizationReason: 'llm_timeout',
      llmRequests: 3,
    });
    expect(toolRegistry.execute).toHaveBeenCalledTimes(1);
    expect(llmClient.chat.mock.calls[0][0]).toMatchObject({
      timeoutMs: 90000,
      deadlineAt: 160000,
      maxAttempts: 2,
    });
    expect(llmClient.chat.mock.calls[1][0]).toMatchObject({
      timeoutMs: 90000,
      deadlineAt: 160000,
      retryTimeouts: false,
    });
    expect(llmClient.chat.mock.calls[2][0]).toMatchObject({
      tools: [],
      timeoutMs: 35000,
      deadlineAt: 200000,
      maxAttempts: 1,
    });
  });

  it('does not execute late tool calls and asks for a final answer without tools', async () => {
    const now = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(15000);
    const call = toolCall('call-1', 'get_diff', '{"path":"src/late.js"}');
    const { runner, llmClient, toolRegistry } = createTestRunner({
      replies: [assistant(null, [call]), assistant('## Summary\nFinal review.')],
      limits: { maxRunDurationMs: 50000, finalizationReserveMs: 40000 },
      now,
    });

    const result = await runner.run({
      apiKey: 'key',
      model: 'model',
      messages: [{ role: 'user', content: 'review' }],
      tools: [{ type: 'function' }],
      runId: 'run-1',
    });

    expect(result).toMatchObject({
      status: 'completed',
      toolCalls: 0,
      finalizedWithAvailableEvidence: true,
      reviewedDiffPaths: [],
    });
    expect(toolRegistry.execute).not.toHaveBeenCalled();
    expect(llmClient.chat.mock.calls[1][0]).toMatchObject({ tools: [] });
    const finalizationToolResult = llmClient.chat.mock.calls[1][0].messages.find(
      (message) => message.role === 'tool',
    );
    expect(JSON.parse(finalizationToolResult.content)).toMatchObject({
      ok: false,
      error: { code: 'FINALIZATION_REQUIRED' },
    });
  });

  it('executes tool calls from one assistant response concurrently and preserves order', async () => {
    const first = toolCall('call-a', 'get_diff', '{"path":"a.ts"}');
    const second = toolCall('call-b', 'get_diff', '{"path":"b.ts"}');
    const completions = [];
    const execute = vi.fn(
      (name, args) =>
        new Promise((resolve) => {
          setTimeout(
            () => {
              completions.push(args.path);
              resolve({ path: args.path });
            },
            args.path === 'a.ts' ? 5 : 0,
          );
        }),
    );
    const { runner, llmClient } = createTestRunner({
      replies: [assistant(null, [first, second]), assistant('done')],
      execute,
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'completed', toolCalls: 2 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(completions).toEqual(['b.ts', 'a.ts']);
    const toolMessages = llmClient.chat.mock.calls[1][0].messages.slice(-2);
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual(['call-a', 'call-b']);
  });

  it('returns malformed arguments as a recoverable tool error', async () => {
    const { runner, llmClient, toolRegistry, logger } = createTestRunner({
      replies: [assistant(null, [toolCall('call-1', 'get_diff', '{bad')]), assistant('done')],
    });

    const result = await runner.run({
      apiKey: 'key',
      model: 'model',
      messages: [],
      tools: [],
      runId: 'run-1',
    });

    expect(result.status).toBe('completed');
    expect(toolRegistry.execute).not.toHaveBeenCalled();
    const toolResult = JSON.parse(llmClient.chat.mock.calls[1][0].messages[1].content);
    expect(toolResult).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TOOL_ARGUMENTS' },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      'Agent tool failed',
      expect.objectContaining({
        tool: 'get_diff',
        success: false,
        errorCode: 'INVALID_TOOL_ARGUMENTS',
      }),
    );
    expect(logger.info).toHaveBeenLastCalledWith(
      'Agent run finished',
      expect.objectContaining({
        usedTools: true,
        tools: ['get_diff'],
        successfulToolCalls: 0,
        failedToolCalls: 1,
      }),
    );
  });

  it('returns unknown tools as a recoverable tool error', async () => {
    const execute = vi.fn().mockRejectedValue(new TypeError('Unknown context tool: get_secrets'));
    const { runner, llmClient } = createTestRunner({
      replies: [assistant(null, [toolCall('call-1', 'get_secrets')]), assistant('done')],
      execute,
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'completed' });
    const toolResult = JSON.parse(llmClient.chat.mock.calls[1][0].messages[1].content);
    expect(toolResult.error).toMatchObject({ code: 'UNKNOWN_TOOL' });
  });

  it('executes calls that fit the global safety limit and finalizes with the rest', async () => {
    const { runner, llmClient, toolRegistry } = createTestRunner({
      replies: [
        assistant(null, [toolCall('a', 'get_diff'), toolCall('b', 'get_diff')]),
        assistant('done'),
      ],
      limits: { maxToolCalls: 1 },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'completed',
      toolCalls: 1,
      requestedToolCalls: 2,
      finalizedWithAvailableEvidence: true,
      finalizationReason: 'tool_call_budget',
    });
    expect(toolRegistry.execute).toHaveBeenCalledTimes(1);
    const rejectedResult = JSON.parse(llmClient.chat.mock.calls[1][0].messages[2].content);
    expect(rejectedResult).toMatchObject({
      ok: false,
      error: { code: 'TOTAL_TOOL_CALL_LIMIT_REACHED' },
    });
    expect(llmClient.chat.mock.calls[1][0].tools).toEqual([]);
  });

  it('allows 50 single-call turns before finalizing without tools', async () => {
    const calls = Array.from({ length: 50 }, (_, index) =>
      toolCall(`call-${index}`, 'get_diff', `{"path":"src/file-${index}.js"}`),
    );
    const { runner, llmClient, toolRegistry } = createTestRunner({
      replies: [...calls.map((call) => assistant(null, [call])), assistant('done')],
      limits: {
        maxToolCalls: 50,
        maxToolCallsPerIteration: 7,
      },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'completed',
      iterations: 50,
      toolCalls: 50,
      requestedToolCalls: 50,
      finalizedWithAvailableEvidence: true,
      finalizationReason: 'tool_call_budget',
      limitReasons: ['max_tool_calls'],
    });
    expect(toolRegistry.execute).toHaveBeenCalledTimes(50);
    expect(llmClient.chat.mock.calls[50][0].tools).toEqual([]);
  });

  it('skips an identical tool request without repeating retrieval or context data', async () => {
    const first = toolCall('call-1', 'get_diff', '{"path":"src/cache.ts"}');
    const duplicate = toolCall('call-2', 'get_diff', '{"path":"src/cache.ts"}');
    const { runner, llmClient, toolRegistry } = createTestRunner({
      replies: [assistant(null, [first, duplicate]), assistant('done')],
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'completed',
      toolCalls: 2,
      successfulToolCalls: 1,
      duplicateToolCalls: 1,
    });
    expect(toolRegistry.execute).toHaveBeenCalledTimes(1);
    const duplicateResult = JSON.parse(llmClient.chat.mock.calls[1][0].messages[2].content);
    expect(duplicateResult).toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_TOOL_REQUEST' },
    });
  });

  it('does not treat iterations as an execution budget', async () => {
    const { runner, toolRegistry } = createTestRunner({
      replies: [
        assistant(null, [toolCall('call-1', 'get_diff', '{"path":"src/a.js"}')]),
        assistant(null, [toolCall('call-2', 'get_diff', '{"path":"src/b.js"}')]),
        assistant('done'),
      ],
      limits: { maxToolCalls: 3 },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'completed', iterations: 2, toolCalls: 2 });
    expect(toolRegistry.execute).toHaveBeenCalledTimes(2);
  });

  it('executes a ninth retrieval turn when eight earlier turns used only 23 calls', async () => {
    const calls = Array.from({ length: 24 }, (_, index) =>
      toolCall(`call-${index}`, 'get_diff', `{"path":"src/file-${index}.js"}`),
    );
    const replies = [
      ...Array.from({ length: 7 }, (_, index) =>
        assistant(null, calls.slice(index * 3, index * 3 + 3)),
      ),
      assistant(null, calls.slice(21, 23)),
      assistant(null, [calls[23]]),
      assistant('done'),
    ];
    const { runner, toolRegistry } = createTestRunner({
      replies,
      limits: { maxToolCalls: 50, maxToolCallsPerIteration: 7 },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'completed',
      iterations: 9,
      toolCalls: 24,
      requestedToolCalls: 24,
    });
    expect(toolRegistry.execute).toHaveBeenCalledTimes(24);
  });

  it('returns one bounded tool result to the model before requiring a final answer', async () => {
    const { runner, llmClient } = createTestRunner({
      replies: [assistant(null, [toolCall('call-1', 'get_file')]), assistant('done')],
      execute: vi.fn().mockResolvedValue({ content: 'too much context' }),
      limits: { maxRetrievedBytes: 1 },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'completed',
      retrievedBytes: 0,
      retrievalBudgetExceeded: true,
    });

    const toolResult = JSON.parse(llmClient.chat.mock.calls[1][0].messages[1].content);
    expect(toolResult).toMatchObject({
      ok: false,
      error: { code: 'TOOL_BUDGET_EXCEEDED' },
    });
  });

  it('finalizes instead of executing another retrieval after the result budget is exhausted', async () => {
    const { runner, llmClient, toolRegistry } = createTestRunner({
      replies: [assistant(null, [toolCall('call-1', 'get_file')]), assistant('done')],
      execute: vi.fn().mockResolvedValue({ content: 'too much context' }),
      limits: { maxRetrievedBytes: 1 },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'completed',
      toolCalls: 1,
      retrievalBudgetExceeded: true,
      finalizedWithAvailableEvidence: true,
      finalizationReason: 'retrieval_budget',
    });
    expect(toolRegistry.execute).toHaveBeenCalledTimes(1);
    expect(llmClient.chat.mock.calls[1][0].tools).toEqual([]);
  });

  it('preserves both retrieval and tool-call limit reasons when both are reached', async () => {
    const { runner, toolRegistry } = createTestRunner({
      replies: [assistant(null, [toolCall('call-1', 'get_file')]), assistant('done')],
      execute: vi.fn().mockResolvedValue({ content: 'too much context' }),
      limits: { maxToolCalls: 1, maxRetrievedBytes: 1 },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'completed',
      toolCalls: 1,
      retrievalBudgetExceeded: true,
      limitReasons: expect.arrayContaining(['max_tool_calls', 'max_retrieved_bytes']),
    });
    expect(toolRegistry.execute).toHaveBeenCalledTimes(1);
  });

  it('returns a protocol failure when a tool call has no id', async () => {
    const { runner } = createTestRunner({
      replies: [
        assistant(null, [{ type: 'function', function: { name: 'get_diff', arguments: '{}' } }]),
      ],
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { category: 'protocol', code: 'AGENT_PROTOCOL_ERROR' },
    });
  });

  it('fails safely when the no-tools finalization request asks for another tool', async () => {
    const { runner, toolRegistry } = createTestRunner({
      replies: [assistant(null, [toolCall('call-1', 'get_diff')])],
      limits: { maxRunDurationMs: 39999, finalizationReserveMs: 40000 },
      now: () => 0,
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { category: 'protocol', code: 'AGENT_FINALIZATION_REQUIRED' },
      requestedToolCalls: 1,
    });
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });

  it('returns transport failures and a timed out run without invoking tools', async () => {
    const failed = createTestRunner({
      replies: [{ success: false, error: { category: 'provider' } }],
    });
    await expect(
      failed.runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'failed', error: { category: 'provider' } });

    const rejected = createTestRunner();
    rejected.llmClient.chat.mockRejectedValue(new Error('network failure'));
    await expect(
      rejected.runner.run({
        apiKey: 'key',
        model: 'model',
        messages: [],
        tools: [],
        runId: 'run-1',
      }),
    ).resolves.toMatchObject({ status: 'failed', error: { category: 'provider' } });

    let clockCalls = 0;
    const timedOut = createTestRunner({
      now: () => (clockCalls++ === 0 ? 0 : 2),
      limits: { maxRunDurationMs: 1 },
    });
    await expect(
      timedOut.runner.run({
        apiKey: 'key',
        model: 'model',
        messages: [],
        tools: [],
        runId: 'run-1',
      }),
    ).resolves.toMatchObject({ status: 'timed_out' });
    expect(timedOut.llmClient.chat).not.toHaveBeenCalled();
  });
});

describe('Agent limits', () => {
  it('retains defaults while accepting positive numeric overrides only', () => {
    expect(resolveAgentLimits({ unknownLimit: 2, maxToolCalls: 0 })).toMatchObject({
      maxToolCalls: 30,
      maxRetrievedBytes: 512 * 1024,
      maxRunDurationMs: 5 * 60 * 1000,
      maxLlmRequestDurationMs: 90000,
      maxLlmAttempts: 2,
      finalLlmRequestDurationMs: 35000,
      finalizationReserveMs: 40000,
    });
    expect(resolveAgentLimits({ unknownLimit: 2 })).not.toHaveProperty('unknownLimit');
  });
});
