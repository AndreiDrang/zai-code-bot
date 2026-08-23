import { describe, expect, it, vi } from 'vitest';
import { prContextDiffKey, prContextKey, prSummaryKey } from '../shared/storage/keys.js';
import { createContextService } from '../shared/context/context-service.js';
import { MAX_CONTEXT_FILE_RANGE_LINES } from '../shared/context/context-limits.js';

const REPO_ID = 10;
const PR = 7;
const HEAD = 'abcdef1234567890';

/**
 * Fake R2 bucket carrying a well-formed V2 snapshot. Individual tests delete
 * or corrupt entries to force the edge states. The real pr-context-reader
 * runs against this bucket.
 */
function makeObjects({ withManifest = true, withFiles = true, withDiff = true } = {}) {
  const manifest = {
    schemaVersion: 2,
    headSha: HEAD,
    title: 'Add feature',
    authorLogin: 'author',
    baseSha: 'base123',
    gatheredAt: '2024-01-01T00:00:00Z',
    counts: { files: 2, commits: 2, issueComments: 1, reviewComments: 1 },
    aggregates: { additions: 5, deletions: 1 },
    contextPrefix: 'v2/prs/10/7/context',
    artifacts: { diffsPrefix: 'diffs/' },
  };
  const files = [
    {
      path: 'a/f',
      status: 'modified',
      additions: 3,
      deletions: 1,
      previousPath: 'a/old',
      diff: { state: 'available', bytes: 20, sha256: 'hash' },
    },
    {
      path: 'b/g',
      status: 'added',
      additions: 2,
      deletions: 0,
      diff: { state: 'unavailable', reason: 'too_large', bytes: null },
    },
  ];
  const objects = new Map([
    [prContextKey(REPO_ID, PR, 'manifest'), withManifest ? JSON.stringify(manifest) : null],
    [
      prContextKey(REPO_ID, PR, 'files'),
      withFiles
        ? JSON.stringify(files)
        : JSON.stringify('not-an-array'),
    ],
    [prContextDiffKey(REPO_ID, PR, 'a/f'), withDiff ? '@@ -1 +1 @@\n+line' : null],
    [prContextKey(REPO_ID, PR, 'description'), 'A feature'],
    [
      prContextKey(REPO_ID, PR, 'commits'),
      JSON.stringify([{ sha: 'c1', title: 'One' }, { sha: 'c2', title: 'Two' }]),
    ],
    [
      prContextKey(REPO_ID, PR, 'comments'),
      JSON.stringify({
        issue: [{ body: 'issue', user: 'u' }],
        review: [{ body: 'review', user: 'v', path: 'a/f' }, { body: 'other', user: 'w', path: 'z/y' }],
      }),
    ],
    [prSummaryKey(REPO_ID, PR), null],
  ]);
  objects.forEach((value, key) => {
    if (value === null) objects.delete(key);
  });
  return objects;
}

function makeService({ objects = makeObjects(), github, expectedHeadSha = HEAD } = {}) {
  const bucket = {
    get: vi.fn(async (key) => {
      const value = objects.get(key);
      return value == null ? null : { text: async () => value };
    }),
  };
  return createContextService({
    bucket,
    github,
    owner: 'o',
    repository: 'r',
    repositoryFullName: 'o/r',
    repositoryId: REPO_ID,
    prNumber: PR,
    expectedHeadSha,
  });
}

const githubWithContent = (impl) => ({
  getFileContent: vi.fn(impl ?? (() => Promise.resolve('file-content'))),
});

describe('context-service — manifest states', () => {
  it('reports a missing snapshot with null head fields', async () => {
    const service = makeService({ objects: makeObjects({ withManifest: false }) });
    await expect(service.getSnapshotState()).resolves.toEqual({
      status: 'missing',
      headSha: null,
      gatheredAt: null,
    });
  });

  it('reports a stale snapshot when the head moved', async () => {
    const service = makeService({ expectedHeadSha: 'other-head' });
    await expect(service.getSnapshotState()).resolves.toMatchObject({ status: 'stale', headSha: HEAD });
  });

  it('omits PR metadata when the manifest is missing', async () => {
    const service = makeService({ objects: makeObjects({ withManifest: false }) });
    await expect(service.getPrMetadata()).resolves.toMatchObject({
      status: 'missing',
      metadata: null,
    });
  });

  it('derives PR metadata from an available manifest', async () => {
    const service = makeService();
    await expect(service.getPrMetadata()).resolves.toMatchObject({
      status: 'available',
      metadata: {
        repository: 'o/r',
        title: 'Add feature',
        author: 'author',
        baseSha: 'base123',
        headSha: HEAD,
        changedFiles: 2,
        additions: 5,
        deletions: 1,
      },
    });
  });
});

describe('context-service — listChangedFiles', () => {
  it('rejects an invalid path prefix', async () => {
    const service = makeService();
    await expect(service.listChangedFiles({ pathPrefix: '../etc' })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('treats an empty prefix as no filter', async () => {
    const service = makeService();
    const res = await service.listChangedFiles({ pathPrefix: '' });
    expect(res.status).toBe('available');
    expect(res.files).toHaveLength(2);
    expect(res.truncated).toBe(false);
  });

  it('filters by prefix and reports truncation', async () => {
    const objects = makeObjects();
    const files = JSON.parse(objects.get(prContextKey(REPO_ID, PR, 'files')));
    files.push({
      path: 'a/h',
      status: 'modified',
      additions: 1,
      deletions: 0,
      diff: { state: 'available', bytes: 4, sha256: 'h' },
    });
    objects.set(prContextKey(REPO_ID, PR, 'files'), JSON.stringify(files));
    const service = makeService({ objects });
    const res = await service.listChangedFiles({ pathPrefix: 'a', limit: 1 });
    expect(res.files.map((f) => f.path)).toEqual(['a/f']);
    expect(res.truncated).toBe(true);
  });

  it('falls back to the default limit for invalid limits', async () => {
    const service = makeService();
    for (const limit of ['x', 0, NaN]) {
      const res = await service.listChangedFiles({ limit });
      expect(res.truncated).toBe(false);
    }
  });

  it('reports a missing file index as missing', async () => {
    const service = makeService({ objects: makeObjects({ withFiles: false }) });
    await expect(service.listChangedFiles()).resolves.toEqual({ status: 'missing', files: [] });
  });

  it('returns no files when the snapshot is stale', async () => {
    const service = makeService({ expectedHeadSha: 'other' });
    await expect(service.listChangedFiles()).resolves.toEqual({ status: 'stale', files: [] });
  });
});

describe('context-service — getDiff', () => {
  it('rejects invalid paths with a status result', async () => {
    const service = makeService();
    await expect(service.getDiff('/abs')).resolves.toMatchObject({ status: 'invalid_path' });
  });

  it('returns the snapshot state when the index is unavailable', async () => {
    const service = makeService({ objects: makeObjects({ withManifest: false }) });
    await expect(service.getDiff('a/f')).resolves.toMatchObject({ status: 'missing', path: 'a/f' });
  });

  it('reports paths outside the snapshot as not_found', async () => {
    const service = makeService();
    await expect(service.getDiff('nope')).resolves.toMatchObject({
      status: 'not_found',
      headSha: HEAD,
    });
  });

  it('defaults a missing unavailable reason to patch_unavailable', async () => {
    const objects = makeObjects();
    objects.set(
      prContextKey(REPO_ID, PR, 'files'),
      JSON.stringify([
        { path: 'a/f', status: 'modified', additions: 1, deletions: 0, diff: { state: 'unavailable' } },
      ]),
    );
    const service = makeService({ objects });
    await expect(service.getDiff('a/f')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'patch_unavailable',
    });
  });

  it('reports a missing diff artifact as artifact_missing', async () => {
    const service = makeService({ objects: makeObjects({ withDiff: false }) });
    await expect(service.getDiff('a/f')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'artifact_missing',
    });
  });

  it('returns a truncated result when the diff exceeds maxBytes', async () => {
    const service = makeService();
    await expect(service.getDiff('a/f', { maxBytes: 3 })).resolves.toMatchObject({
      status: 'available',
      diff: null,
      truncated: true,
    });
  });

  it('returns the stored diff under the byte limit', async () => {
    const service = makeService();
    await expect(service.getDiff('a/f')).resolves.toMatchObject({
      status: 'available',
      diff: '@@ -1 +1 @@\n+line',
      truncated: false,
    });
  });
});

describe('context-service — getFile', () => {
  it('rejects invalid paths', async () => {
    const service = makeService({ github: githubWithContent() });
    await expect(service.getFile('../x')).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('rejects non-head revisions', async () => {
    const service = makeService({ github: githubWithContent() });
    await expect(service.getFile('a/f', { revision: 'base' })).rejects.toMatchObject({
      code: 'INVALID_REVISION',
    });
  });

  it('rejects when source access is not configured', async () => {
    const service = makeService();
    await expect(service.getFile('a/f')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('rejects when the source context is incomplete', async () => {
    // null (not undefined) so the harness default does not kick in
    const service = makeService({ github: githubWithContent(), expectedHeadSha: null });
    await expect(service.getFile('a/f')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });

  it('maps source load failures to FILE_NOT_FOUND', async () => {
    const service = makeService({ github: githubWithContent(() => Promise.reject(new Error('404'))) });
    await expect(service.getFile('a/f')).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
  });

  it('rejects files above the hard source limit', async () => {
    const service = makeService({
      github: githubWithContent(() => Promise.resolve('x'.repeat(5 * 1024 * 1024 + 1))),
    });
    await expect(service.getFile('a/f')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
      details: { maxBytes: 5 * 1024 * 1024 },
    });
  });

  it('truncates softly when maxBytes is exceeded', async () => {
    const service = makeService({ github: githubWithContent(() => Promise.resolve('content')) });
    await expect(service.getFile('a/f', { maxBytes: 3 })).resolves.toMatchObject({
      status: 'available',
      content: null,
      truncated: true,
    });
  });

  it('coerces null source content to an empty string', async () => {
    const service = makeService({ github: githubWithContent(() => Promise.resolve(null)) });
    await expect(service.getFile('a/f')).resolves.toMatchObject({
      status: 'available',
      content: '',
      bytes: 0,
      truncated: false,
    });
  });
});

describe('context-service — getFileRange', () => {
  it('rejects invalid line ranges', async () => {
    const service = makeService({ github: githubWithContent() });
    for (const [startLine, endLine] of [
      [0, 1],
      [2, 1],
      [1, MAX_CONTEXT_FILE_RANGE_LINES + 1],
      ['a', 2],
    ]) {
      await expect(service.getFileRange('a/f', { startLine, endLine })).rejects.toMatchObject({
        code: 'INVALID_LINE_RANGE',
      });
    }
  });

  it('returns numbered lines and clamps the end to the file length', async () => {
    const service = makeService({
      github: githubWithContent(() => Promise.resolve('one\ntwo\nthree')),
    });
    await expect(service.getFileRange('a/f', { startLine: 2, endLine: 10 })).resolves.toMatchObject({
      startLine: 2,
      endLine: 3,
      content: '2 | two\n3 | three',
      returnedLines: 2,
      totalLines: 3,
      truncated: false,
    });
  });

  it('truncates when the rendered range exceeds maxBytes', async () => {
    const service = makeService({ github: githubWithContent(() => Promise.resolve('one\ntwo')) });
    await expect(service.getFileRange('a/f', { startLine: 1, endLine: 2, maxBytes: 3 })).resolves.toMatchObject(
      {
        content: null,
        truncated: true,
      },
    );
  });
});

describe('context-service — getDescription / getCommits / getComments', () => {
  it('truncates the description when it exceeds maxBytes', async () => {
    const service = makeService();
    await expect(service.getDescription({ maxBytes: 2 })).resolves.toMatchObject({
      status: 'available',
      title: 'Add feature',
      body: null,
      truncated: true,
    });
  });

  it('returns the full description with PR metadata', async () => {
    const service = makeService();
    await expect(service.getDescription()).resolves.toMatchObject({
      status: 'available',
      title: 'Add feature',
      body: 'A feature',
      author: 'author',
      baseSha: 'base123',
      truncated: false,
    });
  });

  it('nulls missing description metadata fields', async () => {
    const objects = makeObjects();
    const manifest = JSON.parse(objects.get(prContextKey(REPO_ID, PR, 'manifest')));
    delete manifest.title;
    delete manifest.authorLogin;
    delete manifest.baseSha;
    objects.set(prContextKey(REPO_ID, PR, 'manifest'), JSON.stringify(manifest));
    objects.set(prContextKey(REPO_ID, PR, 'description'), null);
    objects.delete(prContextKey(REPO_ID, PR, 'description'));
    const service = makeService({ objects });
    await expect(service.getDescription()).resolves.toMatchObject({
      status: 'available',
      title: null,
      body: '',
      author: null,
      baseSha: null,
    });
  });

  it('coerces a non-array commits slice to an empty list', async () => {
    const objects = makeObjects();
    objects.set(prContextKey(REPO_ID, PR, 'commits'), '"oops"');
    const service = makeService({ objects });
    await expect(service.getCommits()).resolves.toMatchObject({
      status: 'available',
      commits: [],
      total: 0,
    });
  });

  it('clamps the commit limit and reports truncation', async () => {
    const service = makeService();
    await expect(service.getCommits({ limit: 1 })).resolves.toMatchObject({
      commits: [{ sha: 'c1', title: 'One' }],
      total: 2,
      truncated: true,
    });
    await expect(service.getCommits({ limit: 'x' }).then((r) => r.truncated)).resolves.toBe(false);
  });

  it('filters comments by normalized path', async () => {
    const service = makeService();
    await expect(service.getComments({ path: 'a/f' })).resolves.toMatchObject({
      comments: [{ body: 'review', user: 'v', path: 'a/f' }],
      total: 1,
    });
  });

  it('rejects an invalid comment path', async () => {
    const service = makeService();
    await expect(service.getComments({ path: '..' })).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('drops non-array comment groups and clamps the limit', async () => {
    const objects = makeObjects();
    objects.set(prContextKey(REPO_ID, PR, 'comments'), JSON.stringify({ issue: 'oops' }));
    const service = makeService({ objects });
    await expect(service.getComments()).resolves.toMatchObject({
      comments: [],
      total: 0,
      truncated: false,
    });
  });

  it('reports comment truncation under a tight limit', async () => {
    const service = makeService();
    await expect(service.getComments({ limit: 1 })).resolves.toMatchObject({
      total: 3,
      truncated: true,
    });
  });
});

describe('context-service — getCombinedDiff', () => {
  it('omits files whose stored diff cannot be loaded', async () => {
    const service = makeService({ objects: makeObjects({ withDiff: false }) });
    await expect(service.getCombinedDiff()).resolves.toMatchObject({
      status: 'available',
      diff: '',
      truncated: true,
      omittedPaths: ['a/f'],
    });
  });

  it('omits files that no longer fit under maxBytes', async () => {
    const service = makeService();
    await expect(service.getCombinedDiff({ maxBytes: 5 })).resolves.toMatchObject({
      truncated: true,
      omittedPaths: ['a/f'],
    });
  });

  it('renders removed and added files against /dev/null and honors previousPath', async () => {
    const objects = makeObjects();
    objects.set(prContextDiffKey(REPO_ID, PR, 'a/f'), '-old\n+new');
    objects.set(
      prContextKey(REPO_ID, PR, 'files'),
      JSON.stringify([
        {
          path: 'a/f',
          status: 'removed',
          previousPath: 'a/old',
          additions: 0,
          deletions: 1,
          diff: { state: 'available', bytes: 8, sha256: 'h' },
        },
        {
          path: 'b/g',
          status: 'added',
          additions: 1,
          deletions: 0,
          diff: { state: 'available', bytes: 8, sha256: 'h' },
        },
      ]),
    );
    objects.set(prContextDiffKey(REPO_ID, PR, 'b/g'), '+fresh');
    const service = makeService({ objects });
    const res = await service.getCombinedDiff({ maxBytes: 500 });
    expect(res.diff).toContain('--- a/a/old');
    expect(res.diff).toContain('+++ /dev/null');
    expect(res.diff).toContain('--- /dev/null');
    expect(res.diff).toContain('+++ b/b/g');
  });

  it('returns the snapshot state when the index is unavailable', async () => {
    const service = makeService({ objects: makeObjects({ withManifest: false }) });
    await expect(service.getCombinedDiff()).resolves.toMatchObject({
      status: 'missing',
      diff: '',
      truncated: false,
      omittedPaths: [],
    });
  });
});

describe('context-service — getSnapshotSlices', () => {
  it('returns null metadata and slices for a missing snapshot', async () => {
    const service = makeService({ objects: makeObjects({ withManifest: false }) });
    await expect(service.getSnapshotSlices()).resolves.toEqual({
      status: 'missing',
      headSha: null,
      gatheredAt: null,
      metadata: null,
      slices: null,
    });
  });

  it('skips the combined diff when includeDiff is false', async () => {
    const service = makeService();
    const res = await service.getSnapshotSlices({ includeDiff: false });
    expect(res.status).toBe('available');
    expect(res.slices.diff).toBe('');
    expect(res.diff).toMatchObject({ status: 'not_requested', bytes: 0 });
    expect(res.metadata).toMatchObject({
      repository: 'o/r',
      pullRequest: PR,
      changedFiles: 2,
      additions: 5,
      deletions: 1,
    });
  });

  it('derives changedFiles from aggregates when counts are absent', async () => {
    const objects = makeObjects();
    const manifest = JSON.parse(objects.get(prContextKey(REPO_ID, PR, 'manifest')));
    delete manifest.counts;
    manifest.aggregates = { changedFiles: 7, additions: 5, deletions: 1 };
    objects.set(prContextKey(REPO_ID, PR, 'manifest'), JSON.stringify(manifest));
    const service = makeService({ objects });
    const res = await service.getSnapshotSlices();
    expect(res.metadata.changedFiles).toBe(7);
  });

  it('nulls the repository when both names are missing', async () => {
    const objects = makeObjects();
    const bucket = {
      get: vi.fn(async (key) => {
        const value = objects.get(key);
        return value == null ? null : { text: async () => value };
      }),
    };
    const service = createContextService({
      bucket,
      repositoryId: REPO_ID,
      prNumber: PR,
      expectedHeadSha: HEAD,
    });
    const res = await service.getSnapshotSlices();
    expect(res.metadata.repository).toBeNull();
    expect(res.slices.files[0]).toMatchObject({ status: 'modified', additions: 3, binary: false });
  });
});
