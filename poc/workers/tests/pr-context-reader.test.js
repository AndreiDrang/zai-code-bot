import { describe, expect, it, vi } from 'vitest';
import {
  readPrCard,
  readContextManifest,
  readCommandResult,
  renderContextSummary,
} from '../shared/pr-context-reader.js';
import { prCardKey, prContextKey, prCommandResultKey } from '../shared/storage/keys.js';

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
