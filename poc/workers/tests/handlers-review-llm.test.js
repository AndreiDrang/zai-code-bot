import { describe, expect, it, vi, beforeEach } from 'vitest';
import { prContextKey } from '../shared/storage/keys.js';
import { REVIEW_MARKER } from '../shared/constants.js';

// Hoisted mocks — vi.mock factories run before imports, so the fns live here.
const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  call: vi.fn(),
  upsertComment: vi.fn(),
  writeArtifact: vi.fn(),
  linkRunResultArtifact: vi.fn(),
  getRepositoryConfig: vi.fn(),
}));

vi.mock('../shared/logging.js', () => ({ createLogger: () => mocks.logger }));
vi.mock('../shared/zai-client.js', () => ({
  createZaiClient: () => ({ call: mocks.call, config: {} }),
}));
vi.mock('../shared/comments.js', () => ({ upsertComment: mocks.upsertComment }));
vi.mock('../shared/storage/artifacts.js', () => ({ writeArtifact: mocks.writeArtifact }));
vi.mock('../shared/storage/jobs.js', () => ({
  linkRunResultArtifact: mocks.linkRunResultArtifact,
}));
vi.mock('../shared/storage/config.js', () => ({ getRepositoryConfig: mocks.getRepositoryConfig }));

import { handleReviewCommand } from '../zai-heavy-worker/src/handlers/review.js';

const REPO_ID = 10;
const PR = 7;
const HEAD = 'abcdef1234567890';
const job = {
  job_id: 'job-1',
  repository_id: REPO_ID,
  pr_number: PR,
  head_sha: HEAD,
  repository_owner: 'o',
  repository_name: 'r',
  repository_full_name: 'o/r',
  title: 'Add feature',
  author_login: 'author',
};

/** Fake R2 (context slices + manifest) + KV. Real pr-context-reader runs. */
function makeEnv({
  withDiff = true,
  withFiles = true,
  withDescription = true,
  apiKey = 'zai-key',
} = {}) {
  const bucket = {
    get: vi.fn(async (key) => {
      if (key === prContextKey(REPO_ID, PR, HEAD, 'manifest'))
        return {
          text: async () =>
            JSON.stringify({
              headSha: HEAD,
              counts: { files: 2 },
              aggregates: { additions: 5, deletions: 1 },
            }),
        };
      if (withDiff && key === prContextKey(REPO_ID, PR, HEAD, 'diff'))
        return { text: async () => 'diff --git a/f b/f\n+line' };
      if (withFiles && key === prContextKey(REPO_ID, PR, HEAD, 'files'))
        return { text: async () => JSON.stringify([{ filename: 'a/f' }, { filename: 'b/g' }]) };
      if (withDescription && key === prContextKey(REPO_ID, PR, HEAD, 'description'))
        return { text: async () => 'A feature' };
      return null;
    }),
    put: vi.fn(),
  };
  const cache = { get: vi.fn().mockResolvedValue(null), put: vi.fn() };
  return {
    BOT_ARTIFACTS: bucket,
    BOT_CACHE: cache,
    BOT_DB: {},
    ZAI_API_KEY: apiKey,
    ZAI_MODEL: 'glm-5.2',
  };
}

function makeGithub() {
  return {
    getPrDiff: vi.fn().mockResolvedValue(''),
    getIssueComments: vi.fn().mockResolvedValue([]),
    postComment: vi.fn().mockResolvedValue({ id: 9 }),
    updateComment: vi.fn(),
  };
}

beforeEach(() => {
  mocks.call.mockReset();
  mocks.upsertComment.mockReset();
  mocks.writeArtifact.mockReset();
  mocks.linkRunResultArtifact.mockReset();
  mocks.getRepositoryConfig.mockReset();
  mocks.getRepositoryConfig.mockResolvedValue({ maxContextBytes: 200000, maxFiles: 100 });
  mocks.upsertComment.mockResolvedValue({ id: 42, created: true });
  mocks.writeArtifact.mockResolvedValue({
    artifactId: 'art-1',
    key: 'k',
    sha256: 'h',
    byteLength: 10,
  });
  mocks.linkRunResultArtifact.mockResolvedValue(undefined);
});

describe('/zai review — durable LLM handler', () => {
  it('reviews, persists response.json, links the run, and publishes a review comment', async () => {
    mocks.call.mockResolvedValue({ success: true, data: '## Summary\nGood.' });
    const res = await handleReviewCommand({
      github: makeGithub(),
      env: makeEnv(),
      db: {},
      job,
      runId: 'run-1',
    });

    expect(res).toMatchObject({ status: 'reviewed', artifactId: 'art-1', headSha: HEAD });
    expect(mocks.call).toHaveBeenCalledOnce();
    expect(mocks.writeArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'response', runId: 'run-1', content: '## Summary\nGood.' }),
    );
    expect(mocks.linkRunResultArtifact).toHaveBeenCalledWith({}, 'run-1', 'art-1');
    expect(mocks.upsertComment).toHaveBeenCalledOnce();
    const upsertArg = mocks.upsertComment.mock.calls[0][0];
    expect(upsertArg).toMatchObject({
      commentKind: 'review',
      marker: REVIEW_MARKER,
      headSha: HEAD,
      bodyArtifactId: 'art-1',
      jobId: 'job-1',
      owner: 'o',
      repo: 'r',
    });
    expect(upsertArg.body).toContain('## 🔍 /zai review');
    expect(upsertArg.body).toContain('## Summary\nGood.');
    expect(upsertArg.body).toContain(REVIEW_MARKER);
  });

  it('posts a "not configured" notice and skips the LLM when ZAI_API_KEY is unset', async () => {
    const res = await handleReviewCommand({
      github: makeGithub(),
      env: makeEnv({ apiKey: '' }),
      db: {},
      job,
      runId: 'run-1',
    });
    expect(res.status).toBe('no_api_key');
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.upsertComment).toHaveBeenCalledOnce();
    expect(mocks.upsertComment.mock.calls[0][0].body).toContain('not configured');
  });

  it('posts a "no diff" notice when no diff can be loaded', async () => {
    const github = makeGithub();
    github.getPrDiff.mockResolvedValue(''); // live fallback empty too
    const res = await handleReviewCommand({
      github,
      env: makeEnv({ withDiff: false }),
      db: {},
      job,
      runId: 'run-1',
    });
    expect(res.status).toBe('no_diff');
    expect(mocks.call).not.toHaveBeenCalled();
    expect(mocks.upsertComment.mock.calls[0][0].body).toContain('nothing to review');
  });

  it('falls back to a live getPrDiff when the gathered diff slice is missing', async () => {
    mocks.call.mockResolvedValue({ success: true, data: 'ok' });
    const github = makeGithub();
    github.getPrDiff.mockResolvedValue('live diff content');
    const res = await handleReviewCommand({
      github,
      env: makeEnv({ withDiff: false }),
      db: {},
      job,
      runId: 'run-1',
    });
    expect(res.status).toBe('reviewed');
    expect(github.getPrDiff).toHaveBeenCalledWith('o', 'r', PR);
    expect(mocks.call.mock.calls[0][0].messages[1].content).toContain('live diff content');
  });

  it('posts a sanitized failure notice (no throw, job succeeds) when the LLM fails', async () => {
    mocks.call.mockResolvedValue({
      success: false,
      error: { category: 'provider', retryable: true, attempts: 3 },
    });
    const res = await handleReviewCommand({
      github: makeGithub(),
      env: makeEnv(),
      db: {},
      job,
      runId: 'run-1',
    });
    expect(res).toMatchObject({ status: 'llm_failed', errorCode: 'provider' });
    expect(mocks.writeArtifact).not.toHaveBeenCalled();
    expect(mocks.upsertComment).toHaveBeenCalledOnce();
    expect(mocks.upsertComment.mock.calls[0][0].body).toContain('could not complete');
  });

  it('still publishes the review even if artifact persistence throws', async () => {
    mocks.call.mockResolvedValue({ success: true, data: '## Summary\nGood.' });
    mocks.writeArtifact.mockRejectedValue(new Error('r2 down'));
    const res = await handleReviewCommand({
      github: makeGithub(),
      env: makeEnv(),
      db: {},
      job,
      runId: 'run-1',
    });
    expect(res.status).toBe('reviewed');
    expect(res.artifactId).toBeNull(); // artifact write failed -> null, but comment still posted
    expect(mocks.upsertComment).toHaveBeenCalledOnce();
  });
});
