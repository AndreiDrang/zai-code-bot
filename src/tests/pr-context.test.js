import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handlePrContextJob } from '../zai-heavy-worker/src/handlers/pr-context.js';
import { prContextDiffKey, prContextKey, prCardKey } from '../shared/storage/keys.js';

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
    getAllPrFiles: vi.fn().mockResolvedValue([
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

    const keys = bucket.put.mock.calls.map((c) => c[0]);
    for (const kind of ['manifest', 'files', 'commits', 'description', 'comments']) {
      expect(keys).toContain(prContextKey(10, 7, kind));
    }
    expect(keys).not.toContain('v1/prs/10/7/context/diff.diff');
    // The V2 manifest is the complete snapshot's commit marker.
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

  it('does not commit the manifest until every snapshot artifact write resolves', async () => {
    const store = new Map();
    const pendingWrites = [];
    const manifestKey = prContextKey(10, 7, 'manifest');
    let notifyWritesStarted;
    const writesStarted = new Promise((resolve) => {
      notifyWritesStarted = resolve;
    });
    const bucket = {
      store,
      head: vi.fn(async (key) => (store.has(key) ? { key } : null)),
      get: vi.fn(async (key) => (store.has(key) ? { text: async () => store.get(key) } : null)),
      put: vi.fn((key, value) => {
        if (key === manifestKey) {
          store.set(key, value);
          return Promise.resolve({ key });
        }
        return new Promise((resolve) => {
          pendingWrites.push(() => {
            store.set(key, value);
            resolve({ key });
          });
          notifyWritesStarted();
        });
      }),
    };

    const gathering = handlePrContextJob({
      github: makeGithub({
        getAllPrFiles: vi
          .fn()
          .mockResolvedValue([
            { filename: 'a.js', status: 'modified', patch: '@@ -1 +1 @@\n+new' },
          ]),
      }),
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });

    await writesStarted;
    expect(bucket.put).not.toHaveBeenCalledWith(manifestKey, expect.anything(), expect.anything());

    for (const resolve of pendingWrites) resolve();
    await expect(gathering).resolves.toMatchObject({ status: 'success', action: 'pr_context' });
    expect(bucket.put.mock.calls.at(-1)[0]).toBe(manifestKey);
  });

  it('does not let an older context job overwrite the newest D1 PR head', async () => {
    const bucket = fakeR2();
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({ head_sha: 'newer-head' }),
        })),
      })),
    };

    const result = await handlePrContextJob({
      github: makeGithub(),
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db,
      job: baseJob,
    });

    expect(result).toMatchObject({
      status: 'stale',
      action: 'pr_context',
      headSha: 'abc',
      currentHeadSha: 'newer-head',
    });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('skips a redelivery when the per-PR manifest already describes this same head', async () => {
    const bucket = fakeR2({
      [prContextKey(10, 7, 'manifest')]: JSON.stringify({ schemaVersion: 2, headSha: 'abc' }),
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
      [prContextKey(10, 7, 'manifest')]: JSON.stringify({
        schemaVersion: 2,
        headSha: 'older-head',
      }),
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
      schemaVersion: 2,
      headSha: 'abc',
      contextPrefix: 'v2/prs/10/7/context',
      counts: { files: 2, diffsAvailable: 0, diffsUnavailable: 2 },
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

  it('stores the comments slice via the shared projection (keeps updated_at for edits)', async () => {
    const bucket = fakeR2();
    const github = makeGithub({
      getPrComments: vi.fn().mockResolvedValue({
        issue: [{ user: { login: 'u' }, body: 'edited body', created_at: 't1', updated_at: 't2' }],
        review: [{ user: { login: 'v' }, body: 'nit', path: 'f.js', line: 9, updated_at: 't3' }],
      }),
    });
    await handlePrContextJob({
      github,
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });
    const comments = parseJson(bucket.store.get(prContextKey(10, 7, 'comments')));
    expect(comments.issue[0]).toMatchObject({ user: 'u', body: 'edited body', updated_at: 't2' });
    expect(comments.review[0]).toMatchObject({
      user: 'v',
      body: 'nit',
      path: 'f.js',
      line: 9,
      updated_at: 't3',
    });
  });

  it('does not fetch or store an aggregate diff artifact', async () => {
    const bucket = fakeR2();
    const github = makeGithub({ getPrDiff: vi.fn().mockResolvedValue('x'.repeat(5000)) });
    await handlePrContextJob({
      github,
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });
    expect(github.getPrDiff).not.toHaveBeenCalled();
    expect([...bucket.store.keys()]).not.toContain('v2/prs/10/7/context/diff.diff');
  });

  it('indexes every changed file returned by paginated GitHub retrieval', async () => {
    const bucket = fakeR2();
    const allFiles = Array.from({ length: 101 }, (_, index) => ({
      filename: `src/file-${index}.js`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
    }));
    const github = makeGithub({
      getAllPrFiles: vi.fn().mockResolvedValue(allFiles),
    });

    await handlePrContextJob({
      github,
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });

    expect(github.getAllPrFiles).toHaveBeenCalledWith('o', 'r', 7);
    const files = parseJson(bucket.store.get(prContextKey(10, 7, 'files')));
    expect(files).toHaveLength(101);
    expect(files.at(-1)).toMatchObject({ path: 'src/file-100.js' });
  });

  it('degrades gracefully when a context slice fails', async () => {
    const bucket = fakeR2();
    const res = await handlePrContextJob({
      github: makeGithub({
        getAllPrFiles: vi.fn().mockRejectedValue(new Error('rate limit')),
        getPrDiff: vi.fn().mockRejectedValue(new Error('rate limit')),
      }),
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });
    expect(res.status).toBe('success');
    const manifest = parseJson(bucket.store.get(prContextKey(10, 7, 'manifest')));
    expect(manifest.counts.files).toBe(0); // files slice failed → []
    expect(manifest.counts.diffsAvailable).toBe(0);
    expect(manifest.counts.diffsUnavailable).toBe(0);
  });

  it('stores each changed-file patch without fetching an aggregate unified diff', async () => {
    const bucket = fakeR2();
    const github = makeGithub({
      getAllPrFiles: vi.fn().mockResolvedValue([
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
    expect(github.getPrDiff).not.toHaveBeenCalled();
    const files = parseJson(bucket.store.get(prContextKey(10, 7, 'files')));
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'a.js',
          diff: expect.objectContaining({ state: 'available', bytes: expect.any(Number) }),
        }),
        expect.objectContaining({
          path: 'b.js',
          diff: expect.objectContaining({ state: 'available', bytes: expect.any(Number) }),
        }),
      ]),
    );
    expect(files.every((file) => !Object.hasOwn(file.diff, 'key'))).toBe(true);
    expect(bucket.store.get(prContextDiffKey(10, 7, 'a.js'))).toContain('@@ -1 +1 @@');
    expect(bucket.store.get(prContextDiffKey(10, 7, 'b.js'))).toContain('+added');
  });

  it('marks a binary or unavailable patch explicitly instead of silently truncating it', async () => {
    const bucket = fakeR2();
    const github = makeGithub({
      getAllPrFiles: vi.fn().mockResolvedValue([
        {
          filename: 'assets/logo.png',
          status: 'modified',
          additions: 0,
          deletions: 0,
          changes: 0,
          binary: true,
        },
      ]),
    });
    await handlePrContextJob({
      github,
      env: { BOT_ARTIFACTS: bucket, BOT_CACHE: fakeCache() },
      db: {},
      job: baseJob,
    });
    const files = parseJson(bucket.store.get(prContextKey(10, 7, 'files')));
    expect(files).toEqual([
      expect.objectContaining({
        path: 'assets/logo.png',
        binary: true,
        diff: { state: 'unavailable', reason: 'binary_file', bytes: null },
      }),
    ]);
    expect(bucket.store.has(prContextDiffKey(10, 7, 'assets/logo.png'))).toBe(false);
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
