import { describe, expect, it, vi, beforeEach } from 'vitest';
import { prSummaryKey } from '../shared/storage/keys.js';
import { MAX_JOB_ATTEMPTS } from '../shared/storage/jobs.js';

// Hoisted mocks — vi.mock factories run before imports, so the fns live here.
const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  call: vi.fn(),
  chat: vi.fn(),
  upsertComment: vi.fn(),
  getRepositoryConfig: vi.fn(),
  getSnapshotSlices: vi.fn(),
  agentRun: vi.fn(),
  buildUserPrompt: vi.fn(),
}));

vi.mock('../shared/logging.js', () => ({ createLogger: () => mocks.logger }));
vi.mock('../shared/zai-client.js', () => ({
  createZaiClient: () => ({ call: mocks.call, chat: mocks.chat, config: {} }),
}));
vi.mock('../shared/comments.js', () => ({ upsertComment: mocks.upsertComment }));
vi.mock('../shared/storage/config.js', () => ({ getRepositoryConfig: mocks.getRepositoryConfig }));
vi.mock('../shared/context/context-service.js', () => ({
  createContextService: () => ({ getSnapshotSlices: mocks.getSnapshotSlices }),
}));
vi.mock('../shared/agent/runner.js', () => ({
  createAgentRunner: () => ({ run: mocks.agentRun }),
}));

import { runLlmCommand, buildFailureNotice } from '../shared/llm-command-runner.js';

const REPO_ID = 10;
const PR = 7;
const HEAD = 'abcdef1234567890';

const baseJob = {
  job_id: 'job-1',
  repository_id: REPO_ID,
  pr_number: PR,
  head_sha: HEAD,
  repository_owner: 'o',
  repository_name: 'r',
  repository_full_name: 'o/r',
  title: 'Add feature',
  author_login: 'author',
  attempt_count: 1,
};

/** Fake R2 bucket with an object store the pr-summary tests can seed. */
function makeBucket(objects = new Map()) {
  return {
    get: vi.fn(async (key) => {
      const value = objects.get(key);
      return value == null ? null : { text: async () => value };
    }),
    put: vi.fn(),
  };
}

function makeEnv({ model, bucket } = {}) {
  const env = {
    BOT_ARTIFACTS: bucket ?? makeBucket(),
    BOT_CACHE: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
    ZAI_API_KEY: 'zai-key',
  };
  if (model !== undefined) env.ZAI_MODEL = model;
  return env;
}

function makeOpts(over = {}) {
  return {
    command: 'describe',
    systemPrompt: 'system-prompt',
    buildUserPrompt: mocks.buildUserPrompt,
    commentMarker: '<!-- marker -->',
    commentKind: 'describe',
    emoji: '✨',
    promptVersion: 'v1',
    doneStatus: 'described',
    agentTools: false,
    ...over,
  };
}

function makeCtx({ env = makeEnv(), job = { ...baseJob } } = {}) {
  const github = { getPrDiff: vi.fn().mockResolvedValue('') };
  return { github, env, db: {}, job, runId: 'run-1' };
}

function publishedBody() {
  return mocks.upsertComment.mock.calls[0]?.[0]?.body ?? '';
}

beforeEach(() => {
  for (const fn of [
    mocks.logger.info,
    mocks.logger.warn,
    mocks.logger.error,
    mocks.call,
    mocks.chat,
    mocks.upsertComment,
    mocks.getRepositoryConfig,
    mocks.getSnapshotSlices,
    mocks.agentRun,
    mocks.buildUserPrompt,
  ]) {
    fn.mockReset();
  }
  mocks.getRepositoryConfig.mockResolvedValue({ maxContextBytes: 123456 });
  mocks.getSnapshotSlices.mockResolvedValue({
    status: 'available',
    metadata: null,
    slices: {
      diff: 'diff-body',
      description: 'A feature',
      files: [{ path: 'a/f' }],
      commits: [],
      comments: { issue: [], review: [] },
    },
  });
  mocks.upsertComment.mockResolvedValue({ id: 42, created: true, skipped: false, attempts: 1 });
  mocks.call.mockResolvedValue({ success: true, data: 'RESULT', usedFallback: false });
  mocks.buildUserPrompt.mockReturnValue('user-prompt');
});

describe('runLlmCommand — non-agent path', () => {
  it('completes a non-agent command with null agent defaults', async () => {
    // No ZAI_MODEL in env → default model; usedFallback propagates.
    mocks.call.mockResolvedValue({ success: true, data: 'RESULT', usedFallback: true });
    const res = await runLlmCommand(makeCtx(), makeOpts());

    expect(res).toMatchObject({
      status: 'described',
      usedFallback: true,
      resultStored: true,
      agentUsedTools: false,
      agentIterations: null,
      agentToolCalls: null,
      agentLlmRequests: null,
      agentRetrievedBytes: 0,
      agentLimitReasons: [],
      publicationSkipped: false,
    });
    expect(mocks.call).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'zai-key', model: 'glm-5.2' }),
    );
    expect(mocks.buildUserPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ includeDiff: true, maxBytes: 123456 }),
    );
  });

  it('falls back to the default context byte limit when config is missing', async () => {
    mocks.getRepositoryConfig.mockResolvedValue(null);
    await runLlmCommand(makeCtx(), makeOpts());
    expect(mocks.buildUserPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ maxBytes: 200000 }),
    );
  });

  it('appends zeroed review metadata for a non-agent review', async () => {
    const res = await runLlmCommand(
      makeCtx(),
      makeOpts({ command: 'review', doneStatus: 'reviewed' }),
    );
    expect(res.status).toBe('reviewed');
    const body = publishedBody();
    expect(body).toContain('### Review metadata');
    expect(body).toContain('Context Tool calls executed: 0 (0 successful, 0 failed).');
    expect(body).toContain('Context Tool requests: 0; admitted: 0.');
    expect(body).toContain('Per-file diffs reviewed: none.');
    expect(body).toContain('Retrieved context: 0 bytes.');
    expect(body).toContain('- Finalization: normal completion.');
  });
});

describe('runLlmCommand — snapshot edges', () => {
  it('falls back to a live diff when the snapshot has no diff', async () => {
    mocks.getSnapshotSlices.mockResolvedValue({ status: 'missing' });
    const ctx = makeCtx();
    ctx.github.getPrDiff.mockResolvedValue('live diff');

    const res = await runLlmCommand(ctx, makeOpts());
    expect(res.status).toBe('described');
    expect(res.contextReady).toBe(false);
    expect(mocks.buildUserPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ slices: expect.objectContaining({ diff: 'live diff' }) }),
    );
  });

  it('treats a failing live-diff fallback as no diff', async () => {
    mocks.getSnapshotSlices.mockResolvedValue({ status: 'missing' });
    const ctx = makeCtx();
    ctx.github.getPrDiff.mockRejectedValue(new Error('boom'));

    const res = await runLlmCommand(ctx, makeOpts());
    expect(res.status).toBe('no_diff');
    expect(res.contextReady).toBe(false);
    expect(mocks.call).not.toHaveBeenCalled();
    expect(publishedBody()).toContain('No diff could be loaded');
  });

  it('treats a whitespace-only snapshot diff as empty', async () => {
    mocks.getSnapshotSlices.mockResolvedValue({
      status: 'available',
      metadata: null,
      slices: { diff: '   ' },
    });
    const res = await runLlmCommand(makeCtx(), makeOpts());
    expect(res.status).toBe('no_diff');
  });

  it('requires changed files for agent commands', async () => {
    mocks.getSnapshotSlices.mockResolvedValue({
      status: 'available',
      metadata: null,
      slices: { files: [] },
    });
    const res = await runLlmCommand(makeCtx(), makeOpts({ agentTools: true }));
    expect(res.status).toBe('no_diff');
  });
});

describe('runLlmCommand — stored PR summary', () => {
  const metadata = {
    headSha: HEAD,
    counts: { files: 2, commits: 1 },
    aggregates: { additions: 5, deletions: 1 },
  };

  it('reuses a stored PR summary when heads match', async () => {
    const bucket = makeBucket(
      new Map([
        [
          prSummaryKey(REPO_ID, PR),
          JSON.stringify({
            schemaVersion: 1,
            headSha: HEAD,
            summary: { prSummary: 'Adds caching.' },
          }),
        ],
      ]),
    );
    mocks.getSnapshotSlices.mockResolvedValue({
      status: 'available',
      metadata,
      slices: { diff: 'diff-body' },
    });
    await runLlmCommand(makeCtx({ env: makeEnv({ bucket }) }), makeOpts());
    expect(mocks.buildUserPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prSummary: { prSummary: 'Adds caching.' } }),
    );
  });

  it('ignores a stored PR summary from another head', async () => {
    const bucket = makeBucket(
      new Map([
        [
          prSummaryKey(REPO_ID, PR),
          JSON.stringify({ schemaVersion: 1, headSha: 'other', summary: { prSummary: 'stale' } }),
        ],
      ]),
    );
    mocks.getSnapshotSlices.mockResolvedValue({
      status: 'available',
      metadata,
      slices: { diff: 'diff-body' },
    });
    await runLlmCommand(makeCtx({ env: makeEnv({ bucket }) }), makeOpts());
    expect(mocks.buildUserPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ prSummary: null }),
    );
  });
});

describe('runLlmCommand — failure paths', () => {
  it('maps a missing error category to internal and stays retryable mid-attempts', async () => {
    mocks.call.mockResolvedValue({ success: false, error: { retryable: true } });
    const promise = runLlmCommand(makeCtx(), makeOpts());
    await expect(promise).rejects.toMatchObject({ code: 'llm_internal', retryable: true });
    expect(mocks.upsertComment).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Z.ai call failed',
      expect.objectContaining({ category: 'internal' }),
    );
  });

  it('finalizes an unknown attempt count as the final attempt', async () => {
    mocks.call.mockResolvedValue({ success: false, error: {} });
    const job = { ...baseJob, attempt_count: undefined };
    await expect(runLlmCommand(makeCtx({ job }), makeOpts())).rejects.toMatchObject({
      code: 'llm_internal',
      retryable: false,
    });
    expect(publishedBody()).toContain('internal error');
  });

  it('keeps a rich agent failure retryable before the final attempt', async () => {
    mocks.agentRun.mockResolvedValue({
      status: 'failed',
      error: { category: 'rate_limit', retryable: true, attempts: 2, httpStatus: 429 },
    });
    await expect(runLlmCommand(makeCtx(), makeOpts({ agentTools: true }))).rejects.toMatchObject({
      code: 'llm_rate_limit',
      retryable: true,
    });
    expect(mocks.upsertComment).not.toHaveBeenCalled();
  });

  it('falls back to provider for a failed agent run without error details', async () => {
    mocks.agentRun.mockResolvedValue({ status: 'failed' });
    const job = { ...baseJob, attempt_count: MAX_JOB_ATTEMPTS };
    await expect(
      runLlmCommand(makeCtx({ job }), makeOpts({ agentTools: true })),
    ).rejects.toMatchObject({
      code: 'llm_provider',
      retryable: false,
    });
    expect(publishedBody()).toContain('temporarily unavailable');
  });

  it('keeps timed-out agent runs retryable', async () => {
    mocks.agentRun.mockResolvedValue({ status: 'timed_out' });
    await expect(runLlmCommand(makeCtx(), makeOpts({ agentTools: true }))).rejects.toMatchObject({
      code: 'llm_timed_out',
      retryable: true,
    });
    expect(mocks.upsertComment).not.toHaveBeenCalled();
  });

  it('wraps a throwing agent run as agent_internal on the final attempt', async () => {
    mocks.agentRun.mockRejectedValue(new Error('runner exploded'));
    const job = { ...baseJob, attempt_count: MAX_JOB_ATTEMPTS };
    await expect(
      runLlmCommand(makeCtx({ job }), makeOpts({ agentTools: true })),
    ).rejects.toMatchObject({
      code: 'llm_agent_internal',
      retryable: false,
    });
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'Agent run failed',
      expect.objectContaining({ errorCode: 'agent_internal' }),
    );
    expect(publishedBody()).toContain('internal error');
  });
});

describe('runLlmCommand — agent success metadata', () => {
  const richAgent = {
    usedTools: true,
    iterations: 4,
    toolCalls: 5,
    requestedToolCalls: 7,
    tools: ['get_file_diff'],
    successfulToolCalls: 4,
    failedToolCalls: 1,
    duplicateToolCalls: 2,
    executedToolCalls: 5,
    reviewedDiffPaths: ['a/f', 'a/f', 42, 'b`g', 'c\ng'],
    finalizedWithAvailableEvidence: true,
    finalizationReason: 'retrieval_budget',
    llmRequests: 5,
    llmAttempts: 6,
    llmTimeouts: 1,
    retrievedBytes: 2048,
    retrievalBudgetExceeded: true,
    limitReasons: ['max_tool_calls'],
  };

  it('renders rich review metadata from agent stats', async () => {
    mocks.agentRun.mockResolvedValue({
      status: 'completed',
      response: { content: '## Review' },
      ...richAgent,
    });
    const res = await runLlmCommand(
      makeCtx(),
      makeOpts({ command: 'review', doneStatus: 'reviewed', agentTools: true }),
    );

    expect(res).toMatchObject({
      status: 'reviewed',
      agentUsedTools: true,
      agentIterations: 4,
      agentRetrievedBytes: 2048,
      agentDuplicateToolCalls: 2,
      agentRetrievalBudgetExceeded: true,
      agentLimitReasons: ['max_tool_calls'],
    });
    const body = publishedBody();
    expect(body).toContain('Context Tool calls executed: 5 (4 successful, 1 failed).');
    expect(body).toContain('Context Tool requests: 7; admitted: 5 (2 duplicate requests skipped).');
    expect(body).toContain('`a/f`, `b\\`g`, `c g`');
    expect(body).toContain('Retrieved context: 2 KiB.');
    expect(body).toContain('- Finalization: the context-data budget was reached');
  });

  it('uses the time-reserve finalization line for unknown reasons', async () => {
    mocks.agentRun.mockResolvedValue({
      status: 'completed',
      response: { content: '## Review' },
      finalizedWithAvailableEvidence: true,
      finalizationReason: 'mystery',
      reviewedDiffPaths: ['x/y'],
      retrievedBytes: 512,
      successfulToolCalls: 1,
      toolCalls: 1,
      requestedToolCalls: 1,
    });
    await runLlmCommand(
      makeCtx(),
      makeOpts({ command: 'review', doneStatus: 'reviewed', agentTools: true }),
    );
    const body = publishedBody();
    expect(body).toContain('Retrieved context: 512 bytes.');
    expect(body).toContain('- Finalization: the 40-second time reserve started');
    expect(body).toContain('`x/y`');
  });
});

describe('buildFailureNotice', () => {
  it('explains max_retrieved_bytes with formatted limits', () => {
    const notice = buildFailureNotice({
      command: 'review',
      category: 'max_retrieved_bytes',
      agentLimits: { maxRetrievedBytes: 262144 },
      agent: { retrievedBytes: 250000 },
    });
    expect(notice).toContain('after retrieving 244.1 KiB of 256 KiB');
    expect(notice).toContain('Please retry with `/zai review`.');
  });

  it('explains max_tool_calls without progress when counts are missing', () => {
    const notice = buildFailureNotice({
      command: 'review',
      category: 'max_tool_calls',
      agentLimits: {},
      agent: {},
    });
    expect(notice).toContain('reached its tool-call context-retrieval limit, so it');
    expect(notice).not.toContain('after ');
  });

  it('uses a generic notice for unknown categories', () => {
    const notice = buildFailureNotice({ command: 'review', category: 'weird', error: {} });
    expect(notice).toContain('unexpected service error');
    expect(notice).toContain('Please retry with `/zai review`.');
  });

  it('omits the retry hint for validation failures', () => {
    const notice = buildFailureNotice({ command: 'review', category: 'validation', error: {} });
    expect(notice).not.toContain('Please retry');
  });

  it('formats singular and plural attempt counts', () => {
    expect(
      buildFailureNotice({ command: 'review', category: 'provider', error: { attempts: 1 } }),
    ).toContain('after 1 attempt');
    expect(
      buildFailureNotice({ command: 'review', category: 'provider', error: { attempts: 2 } }),
    ).toContain('after 2 attempts');
    expect(
      buildFailureNotice({ command: 'review', category: 'provider', error: { attempts: 0 } }),
    ).not.toContain('attempt');
  });
});
