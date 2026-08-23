import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRepositoryConfig: vi.fn().mockResolvedValue({ maxContextBytes: 200000 }),
  zaiChat: vi.fn(),
  upsertComment: vi.fn().mockResolvedValue({ status: 'created' }),
}));

vi.mock('../shared/storage/config.js', () => ({
  getRepositoryConfig: mocks.getRepositoryConfig,
}));

vi.mock('../shared/zai-client.js', () => ({
  createZaiClient: vi.fn(() => ({ chat: mocks.zaiChat })),
}));

vi.mock('../shared/comments.js', () => ({
  upsertComment: mocks.upsertComment,
}));

import { prContextDiffKey, prContextKey } from '../shared/storage/keys.js';
import { handleDescribeCommand } from '../zai-heavy-worker/src/handlers/describe.js';

const job = {
  job_id: 'describe-job',
  repository_id: 10,
  pr_number: 7,
  head_sha: 'abc',
  repository_owner: 'owner',
  repository_name: 'repo',
  repository_full_name: 'owner/repo',
};

function assistant(content, toolCalls) {
  return {
    success: true,
    data: {
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      usage: null,
    },
  };
}

function fakeBucket() {
  const store = new Map([
    [
      prContextKey(10, 7, 'manifest'),
      JSON.stringify({
        schemaVersion: 2,
        headSha: 'abc',
        baseSha: 'base',
        title: 'Add cache',
        authorLogin: 'author',
        gatheredAt: '2026-01-01T00:00:00.000Z',
        counts: { files: 1, commits: 1, issueComments: 0, reviewComments: 0 },
        aggregates: { additions: 2, deletions: 1 },
      }),
    ],
    [prContextKey(10, 7, 'description'), 'Adds cache invalidation.'],
    [
      prContextKey(10, 7, 'commits'),
      JSON.stringify([{ sha: 'c1', title: 'Add cache', message: 'Add cache' }]),
    ],
    [
      prContextKey(10, 7, 'files'),
      JSON.stringify([
        {
          path: 'src/cache.js',
          status: 'modified',
          additions: 2,
          deletions: 1,
          diff: { state: 'available' },
        },
      ]),
    ],
    [prContextKey(10, 7, 'comments'), JSON.stringify({ issue: [], review: [] })],
    [prContextDiffKey(10, 7, 'src/cache.js'), '@@ -1 +1 @@\n+invalidateCache();'],
  ]);
  return {
    store,
    get: vi.fn(async (key) => (store.has(key) ? { text: async () => store.get(key) } : null)),
    put: vi.fn(async (key, value) => store.set(key, value)),
  };
}

describe('handleDescribeCommand with Context Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets the describe agent retrieve a diff before updating the bot-owned description block', async () => {
    const bucket = fakeBucket();
    const github = {
      getPullRequest: vi.fn().mockResolvedValue({ body: 'Existing user description.' }),
      updatePullRequest: vi.fn().mockResolvedValue({}),
      getPrCommits: vi.fn(),
      getFileContent: vi.fn(),
    };
    mocks.zaiChat
      .mockResolvedValueOnce(
        assistant(null, [
          {
            id: 'diff-1',
            type: 'function',
            function: { name: 'get_diff', arguments: '{"path":"src/cache.js"}' },
          },
        ]),
      )
      .mockResolvedValueOnce(assistant('## 🚀 Overview\n\nAdd cache invalidation.'));

    const result = await handleDescribeCommand({
      github,
      env: {
        BOT_ARTIFACTS: bucket,
        BOT_CACHE: {},
        ZAI_API_KEY: 'key',
        ZAI_MODEL: 'glm-test',
      },
      db: {},
      job,
      runId: 'run-1',
    });

    expect(result).toMatchObject({
      status: 'updated',
      model: 'glm-test',
      agentUsedTools: true,
      agentTools: ['get_diff'],
      agentSuccessfulToolCalls: 1,
    });
    expect(mocks.zaiChat).toHaveBeenCalledTimes(2);
    const initialRequest = mocks.zaiChat.mock.calls[0][0];
    expect(initialRequest.messages[1].content).toContain('## Changed files');
    expect(initialRequest.messages[1].content).not.toContain('## Diff');
    expect(initialRequest.tools.map((tool) => tool.function.name)).toContain('get_diff');

    const followUp = mocks.zaiChat.mock.calls[1][0];
    const toolResult = followUp.messages.at(-1);
    expect(toolResult).toMatchObject({ role: 'tool', tool_call_id: 'diff-1' });
    expect(JSON.parse(toolResult.content)).toMatchObject({
      ok: true,
      data: {
        path: 'src/cache.js',
        diff: '@@ -1 +1 @@\n+invalidateCache();',
      },
    });
    expect(github.updatePullRequest).toHaveBeenCalledWith(
      'owner',
      'repo',
      7,
      expect.objectContaining({
        body: expect.stringContaining('<!-- zai-description-start -->'),
      }),
    );
  });

  it('throws a retryable failure without publishing an intermediate status comment', async () => {
    const bucket = fakeBucket();
    mocks.zaiChat.mockResolvedValue({
      success: false,
      error: { category: 'timeout', retryable: true },
    });

    await expect(
      handleDescribeCommand({
        github: { getPrCommits: vi.fn(), getFileContent: vi.fn() },
        env: {
          BOT_ARTIFACTS: bucket,
          BOT_CACHE: {},
          ZAI_API_KEY: 'key',
        },
        db: {},
        job: { ...job, attempt_count: 1 },
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ code: 'llm_timeout', retryable: true });

    expect(mocks.upsertComment).not.toHaveBeenCalled();
  });
});
