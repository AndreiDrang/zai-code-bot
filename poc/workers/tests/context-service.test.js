import { describe, expect, it, vi } from 'vitest';
import { createContextService } from '../shared/context/context-service.js';
import { prContextDiffKey, prContextKey } from '../shared/storage/keys.js';

function fakeBucket(objects) {
  return {
    get: vi.fn((key) =>
      Promise.resolve(objects.has(key) ? { text: () => Promise.resolve(objects.get(key)) } : null),
    ),
  };
}

function createSnapshot() {
  const patchKey = prContextDiffKey(10, 7, 'src/cache.ts');
  const objects = new Map([
    [prContextKey(10, 7, 'manifest'), JSON.stringify({ schemaVersion: 2, headSha: 'abc' })],
    [
      prContextKey(10, 7, 'files'),
      JSON.stringify([
        {
          path: 'src/cache.ts',
          status: 'modified',
          diff: { state: 'available', key: patchKey, bytes: 18, sha256: 'hash' },
        },
        {
          path: 'assets/logo.png',
          status: 'modified',
          binary: true,
          diff: { state: 'unavailable', reason: 'binary_file', bytes: null },
        },
      ]),
    ],
    [patchKey, '@@ -1 +1 @@\n+cache'],
    [prContextKey(10, 7, 'description'), 'Add cache'],
    [prContextKey(10, 7, 'commits'), '[]'],
    [prContextKey(10, 7, 'comments'), '{"issue":[],"review":[]}'],
  ]);
  return { objects, patchKey };
}

describe('Context Service', () => {
  it('lists indexed files and reads only the exact indexed patch', async () => {
    const { objects } = createSnapshot();
    const bucket = fakeBucket(objects);
    const github = {
      getFileContent: vi.fn().mockResolvedValue('line one\nline two\nline three'),
    };
    const context = createContextService({
      bucket,
      repositoryId: 10,
      prNumber: 7,
      expectedHeadSha: 'abc',
      github,
      owner: 'owner',
      repository: 'repo',
    });

    await expect(context.listChangedFiles()).resolves.toMatchObject({
      status: 'available',
      files: expect.arrayContaining([expect.objectContaining({ path: 'src/cache.ts' })]),
    });
    await expect(context.listChangedFiles({ pathPrefix: 'src/' })).resolves.toMatchObject({
      files: [expect.objectContaining({ path: 'src/cache.ts' })],
    });
    await expect(context.getDiff('src/cache.ts')).resolves.toMatchObject({
      status: 'available',
      path: 'src/cache.ts',
      diff: '@@ -1 +1 @@\n+cache',
      truncated: false,
    });
    await expect(context.getDiff('../secrets')).resolves.toMatchObject({ status: 'invalid_path' });
    await expect(context.getDiff('unknown.ts')).resolves.toMatchObject({ status: 'not_found' });
    await expect(context.getFile('src/cache.ts')).resolves.toMatchObject({
      content: 'line one\nline two\nline three',
      headSha: 'abc',
    });
    expect(github.getFileContent).toHaveBeenCalledWith('owner', 'repo', 'src/cache.ts', 'abc');
    await expect(
      context.getFileRange('src/cache.ts', { startLine: 2, endLine: 3 }),
    ).resolves.toMatchObject({
      content: '2 | line two\n3 | line three',
      returnedLines: 2,
    });
    await expect(context.getDescription()).resolves.toMatchObject({
      title: null,
      body: 'Add cache',
      headSha: 'abc',
    });
    await expect(context.getCommits()).resolves.toMatchObject({ commits: [] });
    await expect(context.getComments({ path: 'src/cache.ts' })).resolves.toMatchObject({
      comments: [],
    });
  });

  it('returns explicit unavailable and result-limit states without truncating storage', async () => {
    const { objects } = createSnapshot();
    const context = createContextService({
      bucket: fakeBucket(objects),
      repositoryId: 10,
      prNumber: 7,
    });

    await expect(context.getDiff('assets/logo.png')).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'binary_file',
    });
    await expect(context.getDiff('src/cache.ts', { maxBytes: 1 })).resolves.toMatchObject({
      status: 'available',
      diff: null,
      truncated: true,
    });
  });

  it('does not expose a snapshot for a different head SHA', async () => {
    const { objects } = createSnapshot();
    const context = createContextService({
      bucket: fakeBucket(objects),
      repositoryId: 10,
      prNumber: 7,
      expectedHeadSha: 'newer',
    });

    await expect(context.listFiles()).resolves.toMatchObject({ status: 'stale', files: [] });
  });

  it('validates source paths and line ranges', async () => {
    const context = createContextService({
      github: { getFileContent: vi.fn() },
      owner: 'owner',
      repository: 'repo',
      expectedHeadSha: 'abc',
    });

    await expect(context.getFile('../secret')).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await expect(
      context.getFileRange('src/cache.ts', { startLine: 0, endLine: 2 }),
    ).rejects.toMatchObject({ code: 'INVALID_LINE_RANGE' });
  });
});
