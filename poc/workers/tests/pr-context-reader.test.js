import { describe, expect, it, vi } from 'vitest';
import {
  readPrCard,
  readContextManifest,
  renderContextSummary,
  renderPrCardShape,
} from '../shared/pr-context-reader.js';
import { prCardKey, prContextKey } from '../shared/storage/keys.js';

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

  it('renderPrCardShape renders a one-line identity', () => {
    expect(
      renderPrCardShape({
        prNumber: 7,
        authorLogin: 'author',
        headSha: 'abc',
        changedFiles: 3,
        additions: 9,
        deletions: 1,
      }),
    ).toBe('PR context: #7 by @author at `abc` — 3 files (+9/−1).');
  });

  it('renderPrCardShape is empty without a card', () => {
    expect(renderPrCardShape(null)).toBe('');
  });
});
