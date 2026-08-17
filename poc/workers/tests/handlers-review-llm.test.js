import { describe, expect, it, vi, beforeEach } from 'vitest';
import { prCommandResultKey, prContextDiffKey, prContextKey } from '../shared/storage/keys.js';
import { REVIEW_MARKER } from '../shared/constants.js';

// Hoisted mocks — vi.mock factories run before imports, so the fns live here.
const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  call: vi.fn(),
  upsertComment: vi.fn(),
  getRepositoryConfig: vi.fn(),
}));

vi.mock('../shared/logging.js', () => ({ createLogger: () => mocks.logger }));
vi.mock('../shared/zai-client.js', () => ({
  createZaiClient: () => ({ call: mocks.call, config: {} }),
}));
vi.mock('../shared/comments.js', () => ({ upsertComment: mocks.upsertComment }));
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

/**
 * Fake R2 (V2 context artifacts + manifest, with a put() spy) + KV.
 * The real pr-context-reader runs against this bucket.
 */
function makeEnv({
  withDiff = true,
  withFiles = true,
  withDescription = true,
  withCommits = true,
  withComments = true,
  apiKey = 'zai-key',
} = {}) {
  const patchKey = prContextDiffKey(REPO_ID, PR, 'a/f');
  const objects = new Map([
    [
      prContextKey(REPO_ID, PR, 'manifest'),
      JSON.stringify({
        schemaVersion: 2,
        headSha: HEAD,
        counts: { files: 2, commits: 1, issueComments: 0, reviewComments: 0 },
        aggregates: { additions: 5, deletions: 1, storedDiffBytes: 6 },
        contextPrefix: 'v2/prs/10/7/context',
        artifacts: { diffsPrefix: 'diffs/' },
      }),
    ],
    [
      prContextKey(REPO_ID, PR, 'files'),
      withFiles
        ? JSON.stringify([
            {
              path: 'a/f',
              status: 'modified',
              additions: 3,
              deletions: 1,
              diff: withDiff
                ? { state: 'available', bytes: 6, sha256: 'hash' }
                : { state: 'unavailable', reason: 'patch_unavailable', bytes: null },
            },
            {
              path: 'b/g',
              status: 'added',
              additions: 2,
              deletions: 0,
              diff: { state: 'unavailable', reason: 'patch_unavailable', bytes: null },
            },
          ])
        : null,
    ],
    [prContextKey(REPO_ID, PR, 'description'), withDescription ? 'A feature' : null],
    [
      prContextKey(REPO_ID, PR, 'commits'),
      withCommits
        ? JSON.stringify([
            {
              sha: 'cccc111',
              title: 'Add feature',
              message: 'Add feature',
              author: 'author',
              date: '2024-01-01',
            },
          ])
        : null,
    ],
    [
      prContextKey(REPO_ID, PR, 'comments'),
      withComments ? JSON.stringify({ issue: [], review: [] }) : null,
    ],
    [patchKey, withDiff ? '@@ -1 +1 @@\n+line' : null],
  ]);
  const bucket = {
    get: vi.fn(async (key) => {
      const value = objects.get(key);
      return value == null ? null : { text: async () => value };
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
  mocks.getRepositoryConfig.mockReset();
  mocks.getRepositoryConfig.mockResolvedValue({ maxContextBytes: 200000, maxFiles: 100 });
  mocks.upsertComment.mockResolvedValue({ id: 42, created: true });
});

describe('/zai review — durable LLM handler (via runLlmCommand)', () => {
  it('reviews, persists the result to /context/review.md, and publishes a comment', async () => {
    mocks.call.mockResolvedValue({ success: true, data: '## Summary\nGood.' });
    const env = makeEnv();
    const res = await handleReviewCommand({
      github: makeGithub(),
      env,
      db: {},
      job,
      runId: 'run-1',
    });

    expect(res).toMatchObject({ status: 'reviewed', resultStored: true, headSha: HEAD });
    expect(mocks.call).toHaveBeenCalledOnce();

    // The result is written to the per-command /context/ key (overwrite store).
    const expectedKey = prCommandResultKey(REPO_ID, PR, 'review');
    expect(env.BOT_ARTIFACTS.put).toHaveBeenCalledWith(expectedKey, '## Summary\nGood.');

    // Comment is marker-idempotent, no per-run artifact id anymore.
    expect(mocks.upsertComment).toHaveBeenCalledOnce();
    const upsertArg = mocks.upsertComment.mock.calls[0][0];
    expect(upsertArg).toMatchObject({
      commentKind: 'review',
      marker: REVIEW_MARKER,
      headSha: HEAD,
      jobId: 'job-1',
      owner: 'o',
      repo: 'r',
    });
    expect(upsertArg.bodyArtifactId).toBeUndefined();
    expect(upsertArg.body).toContain('## 🔍 /zai review');
    expect(upsertArg.body).toContain('## Summary\nGood.');
    expect(upsertArg.body).toContain(REVIEW_MARKER);
  });

  it('sends the full context (commits + comments) to the LLM, not just the diff', async () => {
    mocks.call.mockResolvedValue({ success: true, data: 'ok' });
    await handleReviewCommand({ github: makeGithub(), env: makeEnv(), db: {}, job, runId: 'r' });
    const userPrompt = mocks.call.mock.calls[0][0].messages[1].content;
    expect(userPrompt).toContain('## Diff');
    expect(userPrompt).toContain('## Commits (1)');
    expect(userPrompt).toContain('`cccc111` Add feature — author');
    expect(userPrompt).toContain('## Description');
    expect(userPrompt).toContain('A feature');
    expect(userPrompt).toContain('## Changed files (2)');
    expect(userPrompt).toContain('"repository":"o/r"');
    expect(userPrompt).toContain('"pullRequest":7');
    expect(userPrompt).not.toContain('contextPrefix');
    expect(userPrompt).not.toContain('diffsPrefix');
    expect(userPrompt).not.toContain('storedDiffBytes');
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
    const env = makeEnv({ withDiff: false });
    const res = await handleReviewCommand({ github, env, db: {}, job, runId: 'run-1' });
    expect(res.status).toBe('no_diff');
    expect(mocks.call).not.toHaveBeenCalled();
    expect(env.BOT_ARTIFACTS.put).not.toHaveBeenCalled();
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
    const env = makeEnv();
    const res = await handleReviewCommand({
      github: makeGithub(),
      env,
      db: {},
      job,
      runId: 'run-1',
    });
    expect(res).toMatchObject({ status: 'llm_failed', errorCode: 'provider' });
    expect(env.BOT_ARTIFACTS.put).not.toHaveBeenCalled(); // nothing persisted on failure
    expect(mocks.upsertComment).toHaveBeenCalledOnce();
    expect(mocks.upsertComment.mock.calls[0][0].body).toContain('could not complete');
  });

  it('still publishes the review even if result persistence (bucket.put) throws', async () => {
    mocks.call.mockResolvedValue({ success: true, data: '## Summary\nGood.' });
    const env = makeEnv();
    env.BOT_ARTIFACTS.put.mockRejectedValue(new Error('r2 down'));
    const res = await handleReviewCommand({
      github: makeGithub(),
      env,
      db: {},
      job,
      runId: 'run-1',
    });
    expect(res.status).toBe('reviewed');
    expect(res.resultStored).toBe(false); // persist failed -> false, but comment still posted
    expect(mocks.upsertComment).toHaveBeenCalledOnce();
  });
});
