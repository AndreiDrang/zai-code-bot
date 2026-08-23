import { describe, expect, it, vi } from 'vitest';

import { projectComments, refreshCommentsSlice } from '../shared/pr-comments.js';
import { prContextKey } from '../shared/storage/keys.js';

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function fakeBucket() {
  const store = new Map();
  return {
    store,
    put: vi.fn((key, bytes) => {
      store.set(key, typeof bytes === 'string' ? bytes : JSON.stringify(bytes));
      return Promise.resolve({ key });
    }),
  };
}

describe('projectComments', () => {
  it('maps issue + review comments and keeps updated_at', () => {
    const out = projectComments({
      issue: [{ user: { login: 'a' }, body: 'hi', created_at: 't1', updated_at: 't2' }],
      review: [{ user: { login: 'b' }, body: 'nits', path: 'f.js', line: 5, updated_at: 't3' }],
    });
    expect(out.issue).toEqual([{ user: 'a', body: 'hi', created_at: 't1', updated_at: 't2' }]);
    expect(out.review).toEqual([
      { user: 'b', body: 'nits', path: 'f.js', line: 5, updated_at: 't3' },
    ]);
  });

  it('tolerates null / missing sources and fields', () => {
    expect(projectComments(null)).toEqual({ issue: [], review: [] });
    expect(projectComments({})).toEqual({ issue: [], review: [] });
    const out = projectComments({ issue: [{ body: 'x' }] });
    expect(out.issue).toHaveLength(1);
    expect(out.issue[0].body).toBe('x');
    expect(out.issue[0].user).toBeUndefined(); // missing user.login → undefined
  });
});

describe('refreshCommentsSlice', () => {
  it('full-refreshes the comments slice under the per-PR key', async () => {
    const bucket = fakeBucket();
    const github = {
      getPrComments: vi.fn().mockResolvedValue({
        issue: [{ user: { login: 'a' }, body: 'hi', updated_at: 't' }],
        review: [],
      }),
    };
    const res = await refreshCommentsSlice({
      github,
      bucket,
      owner: 'o',
      name: 'r',
      prNumber: 7,
      repoId: 10,
    });
    expect(res).toEqual({ refreshed: true, issue: 1, review: 0 });
    // Full re-fetch via getPrComments, capped at 100.
    expect(github.getPrComments).toHaveBeenCalledWith('o', 'r', 7, { maxComments: 100 });
    const stored = parseJson(bucket.store.get(prContextKey(10, 7, 'comments')));
    expect(stored.issue).toHaveLength(1);
    expect(stored.issue[0]).toMatchObject({ user: 'a', body: 'hi', updated_at: 't' });
  });

  it('is idempotent — a re-fetch writes identical bytes, never appends', async () => {
    const bucket = fakeBucket();
    const github = {
      getPrComments: vi
        .fn()
        .mockResolvedValue({ issue: [{ user: { login: 'a' }, body: 'hi' }], review: [] }),
    };
    await refreshCommentsSlice({ github, bucket, owner: 'o', name: 'r', prNumber: 7, repoId: 10 });
    const first = bucket.store.get(prContextKey(10, 7, 'comments'));
    await refreshCommentsSlice({ github, bucket, owner: 'o', name: 'r', prNumber: 7, repoId: 10 });
    const second = bucket.store.get(prContextKey(10, 7, 'comments'));
    // Same projection of the same source → identical bytes (this is the property
    // that makes full-refresh safe vs. an insert-1 path that would duplicate).
    expect(second).toBe(first);
    expect(parseJson(second).issue).toHaveLength(1);
  });

  it('returns refreshed:false when getPrComments fails (best-effort, no write)', async () => {
    const bucket = fakeBucket();
    const github = { getPrComments: vi.fn().mockRejectedValue(new Error('rate limit')) };
    const res = await refreshCommentsSlice({
      github,
      bucket,
      owner: 'o',
      name: 'r',
      prNumber: 7,
      repoId: 10,
    });
    expect(res).toEqual({ refreshed: false });
    expect(bucket.store.size).toBe(0);
  });

  it('returns refreshed:false without an R2 binding (skips the fetch)', async () => {
    const github = { getPrComments: vi.fn().mockResolvedValue({ issue: [], review: [] }) };
    const res = await refreshCommentsSlice({
      github,
      bucket: null,
      owner: 'o',
      name: 'r',
      prNumber: 7,
      repoId: 10,
    });
    expect(res).toEqual({ refreshed: false });
    expect(github.getPrComments).not.toHaveBeenCalled();
  });
});
