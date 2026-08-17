import { describe, expect, it, vi } from 'vitest';
import {
  artifactExpiresAt,
  deleteExpiredArtifacts,
  jsonArtifact,
  listExpiredArtifacts,
  readArtifact,
  writeArtifact,
} from '../shared/storage/artifacts.js';

function fakeDb() {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({ run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }) })),
    })),
  };
}

describe('R2 artifact writer', () => {
  it('uses the uniform 30-day retention contract', () => {
    expect(artifactExpiresAt(new Date('2026-01-01T00:00:00.000Z'))).toBe(
      '2026-01-31T00:00:00.000Z',
    );
    expect(artifactExpiresAt(new Date('2026-01-01T00:00:00.000Z'), '30')).toBe(
      '2026-01-31T00:00:00.000Z',
    );
  });

  it('writes immutable metadata and indexes the object', async () => {
    const bucket = { put: vi.fn().mockResolvedValue(undefined) };
    const db = fakeDb();
    const result = await writeArtifact({
      bucket,
      db,
      jobId: 'job',
      runId: 'run',
      kind: 'result',
      content: 'hello',
      contentType: 'text/plain',
      extension: 'txt',
    });
    expect(bucket.put).toHaveBeenCalledWith(
      'v1/runs/job/run/result.txt',
      expect.any(Uint8Array),
      expect.objectContaining({ httpMetadata: { contentType: 'text/plain' } }),
    );
    expect(result.byteLength).toBe(5);
    expect(result.sha256).toHaveLength(64);
  });

  it('accepts binary content and reads objects through the R2 adapter', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ body: 'ok' }),
    };
    const db = fakeDb();
    await writeArtifact({
      bucket,
      db,
      jobId: 'job',
      runId: 'run',
      kind: 'binary',
      content: new Uint8Array([1, 2]),
      extension: 'bin',
    });
    await writeArtifact({
      bucket,
      db,
      jobId: 'job',
      runId: 'run',
      kind: 'buffer',
      content: new ArrayBuffer(2),
      extension: 'bin',
    });
    await expect(readArtifact(bucket, 'key')).resolves.toEqual({ body: 'ok' });
    expect(jsonArtifact({ ok: true })).toBe('{"ok":true}');
    const emptyDb = {
      prepare: vi.fn(() => ({ bind: () => ({ all: vi.fn().mockResolvedValue({ results: [] }) }) })),
    };
    await expect(listExpiredArtifacts(emptyDb)).resolves.toEqual([]);
    const expiredDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({ results: [{ artifact_id: 'a', r2_key: 'key' }] }),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        })),
      })),
    };
    const expiredBucket = { delete: vi.fn().mockResolvedValue(undefined) };
    await expect(deleteExpiredArtifacts({ db: expiredDb, bucket: expiredBucket })).resolves.toEqual(
      { found: 1, deleted: 1 },
    );
    await expect(
      writeArtifact({ bucket: null, db, jobId: 'j', runId: 'r', kind: 'x', content: 'x' }),
    ).rejects.toThrow('R2');
  });

  it('falls back to the default retention when the input is not a finite number', () => {
    expect(artifactExpiresAt(new Date('2026-01-01T00:00:00.000Z'), 'nope')).toBe(
      '2026-01-31T00:00:00.000Z',
    );
    expect(artifactExpiresAt(new Date('2026-01-01T00:00:00.000Z'), Number.NaN)).toBe(
      '2026-01-31T00:00:00.000Z',
    );
  });

  it('clamps non-positive retention to at least one day', () => {
    expect(artifactExpiresAt(new Date('2026-01-01T00:00:00.000Z'), 0)).toBe(
      '2026-01-02T00:00:00.000Z',
    );
    expect(artifactExpiresAt(new Date('2026-01-01T00:00:00.000Z'), -5)).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('requires an R2 binding to read artifacts', async () => {
    await expect(readArtifact(null, 'key')).rejects.toThrow('R2');
    await expect(readArtifact({}, 'key')).rejects.toThrow('R2');
  });

  it('degrades to an empty artifact list when D1 returns nothing', async () => {
    const emptyDb = {
      prepare: vi.fn(() => ({ bind: () => ({ all: vi.fn().mockResolvedValue(null) }) })),
    };
    await expect(listExpiredArtifacts(emptyDb)).resolves.toEqual([]);
  });

  it('requires an R2 binding to sweep expired artifacts', async () => {
    await expect(deleteExpiredArtifacts({ db: fakeDb(), bucket: null })).rejects.toThrow('R2');
    await expect(
      deleteExpiredArtifacts({ db: fakeDb(), bucket: { delete: 'not-a-fn' } }),
    ).rejects.toThrow('R2');
  });
});
