import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../shared/storage/config.js', () => ({
  getRepositoryConfig: vi.fn().mockResolvedValue({
    enabled: true,
    autoPreview: true,
    maxFiles: 100,
    maxContextBytes: 200000,
  }),
}));

import { handlePrContextJob } from '../zai-heavy-worker/src/handlers/pr-context.js';
import { getRepositoryConfig } from '../shared/storage/config.js';
import { prContextKey, prCardKey } from '../shared/storage/keys.js';

// JSON.parse can throw on malformed input; wrap it so the test bodies stay
// assertion-focused (and satisfy the unchecked-throwing-call guard).
function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const baseJob = {
  job_id: 'job-1',
  delivery_id: 'del-1',
  kind: 'pr_context',
  repository_id: 10,
  pr_number: 7,
  head_sha: 'abc',
  repository_owner: 'o',
  repository_name: 'r',
  repository_full_name: 'o/r',
  title: 'T',
  author_login: 'author',
  state: 'open',
};

function fakeR2(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    head: vi.fn((key) =>
      Promise.resolve(store.has(key) ? { key, size: (store.get(key) || '').length } : null),
    ),
    put: vi.fn((key, bytes) => {
      store.set(key, typeof bytes === 'string' ? bytes : JSON.stringify(bytes));
      return Promise.resolve({ key });
    }),
    get: vi.fn((key) =>
      Promise.resolve(store.has(key) ? { text: () => Promise.resolve(store.get(key)) } : null),
    ),
  };
}

function fakeCache() {
  return { get: vi.fn().mockResolvedValue(null), put: vi.fn().mockResolvedValue(undefined) };
}

function makeGithub(overrides = {}) {
  return {
    getPullRequest: vi.fn().mockResolvedValue({
      title: 'T',
      body: '## body',
      user: { login: 'author' },
      state: 'open',
      changed_files: 3,
      additions: 10,
      deletions: 2,
      head: { sha: 'abc' },
    }),
    getPrFiles: vi.fn().mockResolvedValue([
      { filename: 'a.js', status: 'modified', additions: 5, deletions: 1, changes: 6 },
      { filename: 'b.js', status: 'added', additions: 5, deletions: 1, changes: 6 },
    ]),
    getPrDiff: vi.fn().mockResolvedValue('@@ diff'),
    // Multi-line commit message so we can assert title vs full body storage.
    getPrCommits: vi.fn().mockResolvedValue([
      {
        sha: 'c1',
        commit: {
          message: 'fix: thing\n\nBody line 1.\nBody line 2.',
          author: { name: 'A', date: 'x' },
        },
      },
    ]),
    getPrComments: vi
      .fn()
      .mockResolvedValue({ issue: [{ user: { login: 'u' }, body: 'hi' }], review: [] }),
    ...overrides,
  };
}

describe('handlePrContextJob — gather', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes context objects under per-PR keys and the pr-card to KV', async () => {
    const bucket = fakeR2();
    const cache = fakeCache();
    const res = await handlePrContextJob({
      github: makeGithub(),
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: cache },
      db: {},
      job: baseJob,
    });
    expect(res).toMatchObject({ status: 'success', action: 'pr_context' });

    // Keys are per-PR (repo, pr, kind) — NO headSha segment.
    const keys = bucket.put.mock.calls.map((c) => c[0]);
    for (const kind of ['manifest', 'files', 'diff', 'commits', 'description', 'comments']) {
      expect(keys).toContain(prContextKey(10, 7, kind));
    }
    // Manifest is the commit marker — written last.
    expect(bucket.put.mock.calls.at(-1)[0]).toBe(prContextKey(10, 7, 'manifest'));

    // pr-card keyed by (repo, pr), 30d TTL, carries the head inside.
    expect(cache.put).toHaveBeenCalledWith(
      prCardKey(10, 7),
      expect.any(String),
      expect.objectContaining({ expirationTtl: 30 * 24 * 60 * 60 }),
    );
    const card = parseJson(cache.put.mock.calls[0][1]);
    expect(card).toMatchObject({
      headSha: 'abc',
      contextReady: true,
      changedFiles: 3,
      authorLogin: 'author',
    });
  });

  it('skips a redelivery when the per-PR manifest already describes this same head', async () => {
    const bucket = fakeR2({
      [prContextKey(10, 7, 'manifest')]: JSON.stringify({ headSha: 'abc' }),
    });
    const cache = fakeCache();
    const github = makeGithub();
    const res = await handlePrContextJob({
      github,
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: cache },
      db: {},
      job: baseJob,
    });
    expect(res).toMatchObject({ status: 'skipped', reason: 'same_head_manifest_exists' });
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('re-gathers (overwrites) when the manifest exists for a DIFFERENT head', async () => {
    const bucket = fakeR2({
      [prContextKey(10, 7, 'manifest')]: JSON.stringify({ headSha: 'older-head' }),
    });
    const github = makeGithub();
    const res = await handlePrContextJob({
      github,
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob, // head_sha: 'abc' — newer than the stored 'older-head'
    });
    expect(res).toMatchObject({ status: 'success', action: 'pr_context' });
    expect(github.getPullRequest).toHaveBeenCalled();
    expect(bucket.put).toHaveBeenCalled();
    // The manifest is overwritten with the new head.
    const manifest = parseJson(bucket.store.get(prContextKey(10, 7, 'manifest')));
    expect(manifest.headSha).toBe('abc');
  });

  it('records counts, aggregates, and the per-PR context prefix in the manifest', async () => {
    const bucket = fakeR2();
    const cache = fakeCache();
    await handlePrContextJob({
      github: makeGithub(),
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: cache },
      db: {},
      job: baseJob,
    });
    const manifest = parseJson(bucket.store.get(prContextKey(10, 7, 'manifest')));
    expect(manifest).toMatchObject({
      headSha: 'abc',
      counts: { files: 2, commits: 1, issueComments: 1, reviewComments: 0 },
      aggregates: { changedFiles: 2, additions: 10, deletions: 2 },
      contextPrefix: 'v1/prs/10/7/context',
    });
  });

  it('stores the FULL commit message (title + body) in the commits slice', async () => {
    const bucket = fakeR2();
    await handlePrContextJob({
      github: makeGithub(),
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });
    const commits = parseJson(bucket.store.get(prContextKey(10, 7, 'commits')));
    expect(commits).toHaveLength(1);
    expect(commits[0].title).toBe('fix: thing'); // subject line only
    expect(commits[0].message).toBe('fix: thing\n\nBody line 1.\nBody line 2.'); // full body kept
  });

  it('truncates the diff to the configured byte budget', async () => {
    getRepositoryConfig.mockResolvedValueOnce({
      enabled: true,
      autoPreview: true,
      maxFiles: 100,
      maxContextBytes: 100,
    });
    const bucket = fakeR2();
    await handlePrContextJob({
      github: makeGithub({ getPrDiff: vi.fn().mockResolvedValue('x'.repeat(5000)) }),
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });
    expect(bucket.store.get(prContextKey(10, 7, 'diff')).length).toBe(100);
  });

  it('degrades gracefully when a context slice fails', async () => {
    const bucket = fakeR2();
    const res = await handlePrContextJob({
      github: makeGithub({
        getPrFiles: vi.fn().mockRejectedValue(new Error('rate limit')),
        getPrDiff: vi.fn().mockRejectedValue(new Error('rate limit')),
      }),
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });
    expect(res.status).toBe('success');
    const manifest = parseJson(bucket.store.get(prContextKey(10, 7, 'manifest')));
    expect(manifest.counts.files).toBe(0); // files slice failed → []
    expect(manifest.truncated.diffBytes).toBe(0); // diff slice failed → ''
    expect(manifest.truncated.diffSource).toBe('none'); // no unified, no patches
  });

  it('reconstructs the diff from per-file patches when the unified diff is unavailable (>300-file PRs)', async () => {
    const bucket = fakeR2();
    const github = makeGithub({
      getPrDiff: vi.fn().mockResolvedValue(''), // GitHub 406 "diff too_large" swallowed to ''
      getPrFiles: vi.fn().mockResolvedValue([
        {
          filename: 'a.js',
          status: 'modified',
          additions: 5,
          deletions: 1,
          changes: 6,
          patch: '@@ -1 +1 @@\n-old\n+new',
        },
        {
          filename: 'b.js',
          status: 'added',
          additions: 5,
          deletions: 0,
          changes: 5,
          patch: '@@ -0,0 +1 @@\n+added',
        },
      ]),
    });
    await handlePrContextJob({
      github,
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });
    const storedDiff = bucket.store.get(prContextKey(10, 7, 'diff'));
    expect(storedDiff).toContain('a.js');
    expect(storedDiff).toContain('b.js');
    expect(storedDiff).toContain('@@ -1 +1 @@');
    expect(storedDiff).toContain('+new');
    const manifest = parseJson(bucket.store.get(prContextKey(10, 7, 'manifest')));
    expect(manifest.truncated.diffSource).toBe('reconstructed');
  });

  it('still succeeds with no R2/KV bindings (writes are no-ops)', async () => {
    const res = await handlePrContextJob({
      github: makeGithub(),
      env: {},
      db: {},
      job: baseJob,
    });
    expect(res).toMatchObject({ status: 'success', action: 'pr_context' });
  });
});
