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
    const { runner, llmClient } = createTestRunner({
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
      expect.objectContaining({ apiKey: 'key', model: 'model', tools: [] }),
    );
  });

  it('keeps assistant and tool messages before requesting the final response', async () => {
    const call = toolCall('call-1', 'get_diff', '{"path":"src/cache.ts"}');
    const { runner, llmClient, toolRegistry } = createTestRunner({
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
    const { runner, llmClient, toolRegistry } = createTestRunner({
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

  it('stops before executing calls over the global safety limit', async () => {
    const { runner, toolRegistry } = createTestRunner({
      replies: [assistant(null, [toolCall('a', 'get_diff'), toolCall('b', 'get_diff')])],
      limits: { maxToolCalls: 1 },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'max_tool_calls', toolCalls: 0 });
    expect(toolRegistry.execute).not.toHaveBeenCalled();
  });

  it('stops after the configured iteration limit', async () => {
    const { runner } = createTestRunner({
      replies: [
        assistant(null, [toolCall('call-1', 'get_diff')]),
        assistant(null, [toolCall('call-2', 'get_diff')]),
      ],
      limits: { maxIterations: 1 },
    });

    await expect(
      runner.run({ apiKey: 'key', model: 'model', messages: [], tools: [], runId: 'run-1' }),
    ).resolves.toMatchObject({ status: 'max_iterations', iterations: 1, toolCalls: 1 });
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
    expect(resolveAgentLimits({ maxIterations: 2, maxToolCalls: 0 })).toMatchObject({
      maxIterations: 2,
      maxToolCalls: 30,
    });
  });
});
