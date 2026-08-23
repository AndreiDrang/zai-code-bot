import { describe, expect, it, vi } from 'vitest';

import { refreshDescriptionSlice } from '../shared/pr-description.js';
import { prContextKey } from '../shared/storage/keys.js';

function fakeBucket() {
  const store = new Map();
  return {
    store,
    put: vi.fn((key, bytes) => {
      store.set(key, bytes);
      return Promise.resolve({ key });
    }),
  };
}

describe('refreshDescriptionSlice', () => {
  it('writes the body to description.md under the per-PR key', async () => {
    const bucket = fakeBucket();
    const body = '## new description';
    const res = await refreshDescriptionSlice({ bucket, repoId: 10, prNumber: 7, body });
    expect(res).toMatchObject({ refreshed: true, bytes: body.length });
    expect(bucket.store.get(prContextKey(10, 7, 'description'))).toBe(body);
  });

  it('coerces a null body to empty string (gather writes body || "")', async () => {
    const bucket = fakeBucket();
    await refreshDescriptionSlice({ bucket, repoId: 10, prNumber: 7, body: null });
    expect(bucket.store.get(prContextKey(10, 7, 'description'))).toBe('');
  });

  it('is idempotent — the same body writes identical bytes', async () => {
    const bucket = fakeBucket();
    await refreshDescriptionSlice({ bucket, repoId: 10, prNumber: 7, body: 'desc' });
    const first = bucket.store.get(prContextKey(10, 7, 'description'));
    await refreshDescriptionSlice({ bucket, repoId: 10, prNumber: 7, body: 'desc' });
    expect(bucket.store.get(prContextKey(10, 7, 'description'))).toBe(first);
  });

  it('returns refreshed:false without an R2 binding', async () => {
    const res = await refreshDescriptionSlice({ bucket: null, repoId: 10, prNumber: 7, body: 'x' });
    expect(res).toEqual({ refreshed: false });
  });

  it('returns refreshed:false when repo / PR identity is missing', async () => {
    const bucket = fakeBucket();
    expect(await refreshDescriptionSlice({ bucket, repoId: null, prNumber: 7, body: 'x' })).toEqual(
      { refreshed: false },
    );
    expect(
      await refreshDescriptionSlice({ bucket, repoId: 10, prNumber: null, body: 'x' }),
    ).toEqual({ refreshed: false });
  });
});
