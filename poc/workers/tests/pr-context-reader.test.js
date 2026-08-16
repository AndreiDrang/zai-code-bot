import { describe, expect, it, vi } from 'vitest';
import {
  readPrCard,
  readContextManifest,
  readContextV2Diff,
  readContextV2Files,
  readContextV2Manifest,
  readCommandResult,
  readPrSummary,
  renderContextSummary,
} from '../shared/pr-context-reader.js';
import {
  prCardKey,
  prContextKey,
  prContextV2DiffKey,
  prContextV2Key,
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
    const manifest = { headSha: 'abc', counts: { files: 2 } };
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

describe('V2 context readers — per-file artifacts', () => {
  const file = {
    path: 'src/cache.ts',
    diff: {
      state: 'available',
      key: prContextV2DiffKey(10, 7, 'src/cache.ts'),
      bytes: 12,
      sha256: 'abc',
    },
  };

  it('reads the V2 manifest, files index, and an indexed patch', async () => {
    const manifest = { schemaVersion: 2, headSha: 'abc' };
    const files = [file];
    const objects = new Map([
      [prContextV2Key(10, 7, 'manifest'), JSON.stringify(manifest)],
      [prContextV2Key(10, 7, 'files'), JSON.stringify(files)],
      [prContextV2DiffKey(10, 7, 'src/cache.ts'), '@@ -1 +1 @@\n+cache'],
    ]);
    const bucket = {
      get: vi.fn((key) =>
        Promise.resolve(
          objects.has(key) ? { text: () => Promise.resolve(objects.get(key)) } : null,
        ),
      ),
    };

    await expect(readContextV2Manifest(bucket, 10, 7)).resolves.toEqual(manifest);
    await expect(readContextV2Files(bucket, 10, 7)).resolves.toEqual(files);
    await expect(readContextV2Diff(bucket, 10, 7, file)).resolves.toContain('+cache');
  });

  it('refuses a diff entry whose key does not match its indexed path', async () => {
    const bucket = { get: vi.fn() };
    await expect(
      readContextV2Diff(bucket, 10, 7, {
        ...file,
        diff: { ...file.diff, key: 'v2/prs/10/7/context/diffs/other.patch' },
      }),
    ).resolves.toBeNull();
    expect(bucket.get).not.toHaveBeenCalled();
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
