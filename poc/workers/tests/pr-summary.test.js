import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRepositoryConfig: vi.fn().mockResolvedValue({ maxContextBytes: 200000 }),
  zaiCall: vi.fn(),
}));

vi.mock('../shared/storage/config.js', () => ({
  getRepositoryConfig: mocks.getRepositoryConfig,
}));

vi.mock('../shared/zai-client.js', () => ({
  createZaiClient: vi.fn(() => ({ call: mocks.zaiCall })),
}));

import { prContextDiffKey, prContextKey, prSummaryKey } from '../shared/storage/keys.js';
import {
  handlePrSummaryJob,
  validatePrSummary,
} from '../zai-heavy-worker/src/handlers/pr-summary.js';

const job = {
  job_id: 'summary-job',
  repository_id: 10,
  pr_number: 7,
  head_sha: 'abc',
  repository_full_name: 'owner/repo',
  title: 'Add X',
  author_login: 'author',
};

const manifest = {
  schemaVersion: 2,
  headSha: 'abc',
  baseSha: 'base',
  title: 'Add X',
  authorLogin: 'author',
  gatheredAt: '2026-01-01T00:00:00.000Z',
  counts: { files: 1, commits: 1, issueComments: 1, reviewComments: 0 },
  aggregates: { additions: 2, deletions: 1 },
};

function fakeBucket() {
  const patchKey = prContextDiffKey(10, 7, 'src/x.js');
  const store = new Map([
    [
      prContextKey(10, 7, 'manifest'),
      JSON.stringify({ ...manifest, artifacts: { files: 'files.json' } }),
    ],
    [prContextKey(10, 7, 'description'), 'Adds X.'],
    [
      prContextKey(10, 7, 'commits'),
      JSON.stringify([{ sha: 'c1', title: 'Add X', message: 'Add X' }]),
    ],
    [
      prContextKey(10, 7, 'files'),
      JSON.stringify([
        {
          path: 'src/x.js',
          status: 'added',
          additions: 2,
          deletions: 1,
          diff: { state: 'available', key: patchKey, bytes: 5, sha256: 'hash' },
        },
      ]),
    ],
    [
      prContextKey(10, 7, 'comments'),
      JSON.stringify({ issue: [{ user: 'u', body: 'Why?' }], review: [] }),
    ],
    [patchKey, '@@ -1 +1 @@\n+new'],
  ]);
  return {
    store,
    get: vi.fn(async (key) => {
      if (!store.has(key)) return null;
      return { text: async () => store.get(key) };
    }),
    put: vi.fn(async (key, value) => {
      store.set(key, value);
    }),
  };
}

const validSummary = {
  prSummary: 'Adds X to improve processing.',
  keyChanges: [{ file: 'src/x.js', change: 'Adds the new processing logic.' }],
  conversationSummary: {
    mainTopic: null,
    unresolvedQuestions: [],
    resolvedQuestions: 0,
  },
};

describe('handlePrSummaryJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.zaiCall.mockResolvedValue({ success: true, data: JSON.stringify(validSummary) });
  });

  it('sends all five gathered slices and stores a versioned JSON artifact', async () => {
    const bucket = fakeBucket();
    const result = await handlePrSummaryJob({
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: {}, ZAI_API_KEY: 'key', ZAI_MODEL: 'glm-test' },
      db: {},
      job,
    });

    expect(result).toMatchObject({ status: 'success', action: 'pr_summary', headSha: 'abc' });
    expect(mocks.zaiCall).toHaveBeenCalledOnce();
    const request = mocks.zaiCall.mock.calls[0][0];
    expect(request.model).toBe('glm-test');
    expect(request.messages[0].role).toBe('system');
    expect(request.messages[1].content).toContain('## Description');
    expect(request.messages[1].content).toContain('## Commits');
    expect(request.messages[1].content).toContain('## Changed files');
    expect(request.messages[1].content).toContain('## Conversation');
    expect(request.messages[1].content).toContain('## Diff');
    expect(request.fallbackMessages).toBeDefined();
    expect(request.fallbackMessages[1].content.length).toBeLessThanOrEqual(
      request.messages[1].content.length,
    );

    const artifact = JSON.parse(bucket.store.get(prSummaryKey(10, 7)));
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      headSha: 'abc',
      model: 'glm-test',
      promptVersion: 'pr-summary-v1',
      summary: validSummary,
    });
  });

  it('does not call the provider when the API key is missing', async () => {
    const result = await handlePrSummaryJob({
      env: { BOT_ARTIFACTS: fakeBucket(), BOT_CACHE: {} },
      db: {},
      job,
    });
    expect(result.status).toBe('no_api_key');
    expect(mocks.zaiCall).not.toHaveBeenCalled();
  });

  it('loads the V2 per-file snapshot', async () => {
    const bucket = fakeBucket();
    await expect(
      handlePrSummaryJob({
        env: { BOT_ARTIFACTS: bucket, BOT_CACHE: {}, ZAI_API_KEY: 'key' },
        db: {},
        job,
      }),
    ).resolves.toMatchObject({ status: 'success' });

    const request = mocks.zaiCall.mock.calls[0][0];
    expect(request.messages[1].content).toContain('src/x.js (added, +2/-1)');
    expect(request.messages[1].content).toContain('@@ -1 +1 @@');
    expect(bucket.get).not.toHaveBeenCalledWith('v2/prs/10/7/context/diff.diff');
  });

  it('rejects malformed model output before writing the artifact', async () => {
    const bucket = fakeBucket();
    mocks.zaiCall.mockResolvedValue({ success: true, data: '{"prSummary":"only"}' });
    await expect(
      handlePrSummaryJob({
        env: { BOT_ARTIFACTS: bucket, BOT_CACHE: {}, ZAI_API_KEY: 'key' },
        db: {},
        job,
      }),
    ).rejects.toMatchObject({ code: 'pr_summary_invalid_json', retryable: true });
    expect(bucket.put).not.toHaveBeenCalled();
  });
});

describe('validatePrSummary', () => {
  it('rejects unknown fields', () => {
    expect(() => validatePrSummary({ ...validSummary, extra: true })).toThrow(
      'Unexpected summary fields',
    );
  });
});
