import { describe, expect, it, vi } from 'vitest';
import {
  readPrCard,
  readContextDiff,
  readContextFiles,
  readContextManifest,
  readContextSlice,
  readCommandResult,
  readPrSummary,
  renderContextSummary,
} from '../shared/pr-context-reader.js';
import {
  prCardKey,
  prContextDiffKey,
  prContextKey,
  prCommandResultKey,
  prSummaryKey,
} from '../shared/storage/keys.js';

describe('readPrCard — KV pr-card', () => {
  it('returns the parsed card on a hit', async () => {
    const card = { headSha: 'abc', changedFiles: 3, contextReady: true };
    const cache = { get: vi.fn().mockResolvedValue(card) };
    await expect(readPrCard(cache, 10, 7)).resolves.toEqual(card);
    expect(cache.get).toHaveBeenCalledWith(prCardKey(10, 7), { type: 'json' });
  });

  it('returns null on a miss', async () => {
    const cache = { get: vi.fn().mockResolvedValue(null) };
    await expect(readPrCard(cache, 10, 7)).resolves.toBeNull();
  });

  it('returns null when the cache get throws (derivative tier)', async () => {
    const cache = { get: vi.fn().mockRejectedValue(new Error('KV down')) };
    await expect(readPrCard(cache, 10, 7)).resolves.toBeNull();
  });

  it('returns null without a cache binding or pr number', async () => {
    await expect(readPrCard(null, 10, 7)).resolves.toBeNull();
    await expect(readPrCard({ get: vi.fn() }, 10, null)).resolves.toBeNull();
  });
});

describe('readContextManifest — R2 manifest', () => {
  it('parses the manifest object (per-PR latest)', async () => {
    const manifest = { schemaVersion: 2, headSha: 'abc', counts: { files: 2 } };
    const bucket = {
      get: vi.fn().mockResolvedValue({ text: () => Promise.resolve(JSON.stringify(manifest)) }),
    };
    await expect(readContextManifest(bucket, 10, 7)).resolves.toEqual(manifest);
    expect(bucket.get).toHaveBeenCalledWith(prContextKey(10, 7, 'manifest'));
  });

  it('returns null when no manifest exists', async () => {
    const bucket = { get: vi.fn().mockResolvedValue(null) };
    await expect(readContextManifest(bucket, 10, 7)).resolves.toBeNull();
  });

  it('does not read a legacy V1 manifest when the V2 key is absent', async () => {
    const bucket = {
      get: vi.fn((key) =>
        Promise.resolve(
          key === 'v1/prs/10/7/context/manifest.json'
            ? { text: () => Promise.resolve(JSON.stringify({ headSha: 'abc' })) }
            : null,
        ),
      ),
    };
    await expect(readContextManifest(bucket, 10, 7)).resolves.toBeNull();
    expect(bucket.get).toHaveBeenCalledWith(prContextKey(10, 7, 'manifest'));
  });

  it('uses R2 head before get so an expected miss is not logged as GetObject error', async () => {
    const bucket = {
      head: vi.fn().mockResolvedValue(null),
      get: vi.fn(),
    };
    await expect(readContextManifest(bucket, 10, 7)).resolves.toBeNull();
    expect(bucket.head).toHaveBeenCalledWith(prContextKey(10, 7, 'manifest'));
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it('uses R2 list before get so a missing key does not create an error span', async () => {
    const bucket = {
      list: vi.fn().mockResolvedValue({ objects: [] }),
      get: vi.fn(),
    };
    await expect(readContextManifest(bucket, 10, 7)).resolves.toBeNull();
    expect(bucket.list).toHaveBeenCalledWith({
      prefix: prContextKey(10, 7, 'manifest'),
      limit: 1,
    });
    expect(bucket.get).not.toHaveBeenCalled();
  });
});

describe('context readers — V2 per-file artifacts', () => {
  const file = {
    path: 'src/cache.ts',
    diff: {
      state: 'available',
      bytes: 12,
      sha256: 'abc',
    },
  };

  it('reads the manifest, files index, and an indexed patch', async () => {
    const manifest = { schemaVersion: 2, headSha: 'abc' };
    const files = [file];
    const objects = new Map([
      [prContextKey(10, 7, 'manifest'), JSON.stringify(manifest)],
      [prContextKey(10, 7, 'files'), JSON.stringify(files)],
      [prContextDiffKey(10, 7, 'src/cache.ts'), '@@ -1 +1 @@\n+cache'],
    ]);
    const bucket = {
      get: vi.fn((key) =>
        Promise.resolve(
          objects.has(key) ? { text: () => Promise.resolve(objects.get(key)) } : null,
        ),
      ),
    };

    await expect(readContextManifest(bucket, 10, 7)).resolves.toEqual(manifest);
    await expect(readContextFiles(bucket, 10, 7)).resolves.toEqual(files);
    await expect(readContextDiff(bucket, 10, 7, file)).resolves.toContain('+cache');
  });

  it('derives the artifact key from the indexed path rather than file metadata', async () => {
    const bucket = {
      get: vi.fn().mockResolvedValue({ text: () => Promise.resolve('@@ -1 +1 @@\n+cache') }),
    };
    await expect(
      readContextDiff(bucket, 10, 7, {
        ...file,
        diff: { ...file.diff, key: 'v2/prs/10/7/context/diffs/other.patch' },
      }),
    ).resolves.toContain('+cache');
    expect(bucket.get).toHaveBeenCalledWith(prContextDiffKey(10, 7, 'src/cache.ts'));
  });
});

describe('readCommandResult — R2 latest command output', () => {
  it('returns the stored markdown text on a hit', async () => {
    const bucket = {
      get: vi.fn().mockResolvedValue({ text: () => Promise.resolve('## Summary\nGood.') }),
    };
    await expect(readCommandResult(bucket, 10, 7, 'review')).resolves.toBe('## Summary\nGood.');
    expect(bucket.get).toHaveBeenCalledWith(prCommandResultKey(10, 7, 'review'));
  });

  it('returns null when no result is stored for that command', async () => {
    const bucket = { get: vi.fn().mockResolvedValue(null) };
    await expect(readCommandResult(bucket, 10, 7, 'review')).resolves.toBeNull();
  });

  it('returns null when the bucket get throws (derivative tier)', async () => {
    const bucket = { get: vi.fn().mockRejectedValue(new Error('R2 down')) };
    await expect(readCommandResult(bucket, 10, 7, 'review')).resolves.toBeNull();
  });

  it('returns null without a bucket binding or identifiers', async () => {
    await expect(readCommandResult(null, 10, 7, 'review')).resolves.toBeNull();
    await expect(readCommandResult({ get: vi.fn() }, 10, null, 'review')).resolves.toBeNull();
    await expect(readCommandResult({ get: vi.fn() }, 10, 7, null)).resolves.toBeNull();
  });
});

describe('readPrSummary — structured PR context', () => {
  it('returns a schema-versioned summary on a hit', async () => {
    const value = {
      schemaVersion: 1,
      headSha: 'abc',
      summary: { prSummary: 'Adds X' },
    };
    const bucket = {
      get: vi.fn().mockResolvedValue({ text: () => Promise.resolve(JSON.stringify(value)) }),
    };
    await expect(readPrSummary(bucket, 10, 7)).resolves.toEqual(value);
    expect(bucket.get).toHaveBeenCalledWith(prSummaryKey(10, 7));
  });

  it('returns null for missing, malformed, or unsupported summaries', async () => {
    await expect(
      readPrSummary({ get: vi.fn().mockResolvedValue(null) }, 10, 7),
    ).resolves.toBeNull();
    await expect(
      readPrSummary(
        { get: vi.fn().mockResolvedValue({ text: () => Promise.resolve('not-json') }) },
        10,
        7,
      ),
    ).resolves.toBeNull();
    await expect(
      readPrSummary(
        {
          get: vi.fn().mockResolvedValue({
            text: () => Promise.resolve(JSON.stringify({ schemaVersion: 2, summary: {} })),
          }),
        },
        10,
        7,
      ),
    ).resolves.toBeNull();
  });
});

describe('renderers', () => {
  it('renderContextSummary describes the gathered context', () => {
    const out = renderContextSummary({
      headSha: 'abc',
      counts: { files: 4, commits: 2, issueComments: 1, reviewComments: 3 },
      aggregates: { additions: 10, deletions: 4 },
    });
    expect(out).toContain('`abc`');
    expect(out).toContain('4 files');
    expect(out).toContain('+10/−4');
    expect(out).toContain('2 commits');
    expect(out).toContain('4 comments'); // issue + review
  });

  it('renderContextSummary is empty without a manifest', () => {
    expect(renderContextSummary(null)).toBe('');
  });
});

describe('context readers — defensive null paths', () => {
  const raw = (value) => ({ text: async () => value });
  const json = (value) => ({ text: async () => JSON.stringify(value) });

  it('readContextManifest rejects malformed payloads and wrong schema shapes', async () => {
    const bucket = { get: vi.fn() };
    bucket.get
      .mockResolvedValueOnce(raw('not-json')) // JSON.parse throws → catch
      .mockResolvedValueOnce(json({ schemaVersion: 1, headSha: 'abc' })) // wrong version
      .mockResolvedValueOnce(json({ schemaVersion: 2, headSha: 42 })); // headSha not a string
    for (let i = 0; i < 3; i += 1) {
      await expect(readContextManifest(bucket, 10, 7)).resolves.toBeNull();
    }
  });

  it('readContextSlice returns raw text for description, parsed JSON otherwise', async () => {
    const bucket = { get: vi.fn() };
    bucket.get
      .mockResolvedValueOnce(raw('A feature')) // description → text passthrough
      .mockResolvedValueOnce(json({ issue: [], review: [] })); // comments → parsed JSON
    await expect(readContextSlice(bucket, 10, 7, 'description')).resolves.toBe('A feature');
    await expect(readContextSlice(bucket, 10, 7, 'comments')).resolves.toEqual({
      issue: [],
      review: [],
    });
  });

  it('readContextSlice requires a bucket, identifiers, and an existing object', async () => {
    await expect(readContextSlice(null, 10, 7, 'comments')).resolves.toBeNull();
    await expect(readContextSlice({ get: vi.fn() }, null, 7, 'comments')).resolves.toBeNull();
    await expect(readContextSlice({ get: vi.fn() }, 10, null, 'comments')).resolves.toBeNull();
    const missing = { get: vi.fn().mockResolvedValue(null) };
    await expect(readContextSlice(missing, 10, 7, 'commits')).resolves.toBeNull();
    const broken = { get: vi.fn().mockResolvedValue(raw('not-json')) };
    await expect(readContextSlice(broken, 10, 7, 'commits')).resolves.toBeNull();
  });

  it('readContextFiles requires an array payload', async () => {
    const objectPayload = { get: vi.fn().mockResolvedValue(json({ not: 'an array' })) };
    await expect(readContextFiles(objectPayload, 10, 7)).resolves.toBeNull();
    const missing = { get: vi.fn().mockResolvedValue(null) };
    await expect(readContextFiles(missing, 10, 7)).resolves.toBeNull();
  });

  it('readContextDiff validates the indexed file entry before touching R2', async () => {
    const bucket = { get: vi.fn() };
    await expect(readContextDiff(bucket, 10, 7, null)).resolves.toBeNull();
    await expect(
      readContextDiff(bucket, 10, 7, { path: 'a/f', diff: { state: 'unavailable' } }),
    ).resolves.toBeNull();
    await expect(
      readContextDiff(bucket, 10, 7, { path: 42, diff: { state: 'available' } }),
    ).resolves.toBeNull();
    expect(bucket.get).not.toHaveBeenCalled();

    bucket.get.mockResolvedValueOnce(null); // indexed but object missing
    await expect(
      readContextDiff(bucket, 10, 7, { path: 'a/f', diff: { state: 'available' } }),
    ).resolves.toBeNull();

    bucket.get.mockRejectedValueOnce(new Error('r2 down'));
    await expect(
      readContextDiff(bucket, 10, 7, { path: 'a/f', diff: { state: 'available' } }),
    ).resolves.toBeNull();
  });
});
