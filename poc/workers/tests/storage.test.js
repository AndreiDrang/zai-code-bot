import { describe, expect, it } from 'vitest';
import {
  deliveryArtifactKey,
  prCardKey,
  prCommandResultKey,
  prContextKey,
  prContextV2DiffKey,
  prContextV2Key,
  normalizeRepositoryPath,
  repoConfigCacheKey,
  runArtifactKey,
} from '../shared/storage/keys.js';
import {
  extractPullRequestEvent,
  isSupportedPullRequestEvent,
} from '../zai-main-worker/src/pr-events.js';

describe('storage key contracts', () => {
  it('creates versioned keys for bot-storage and bot-cache consumers', () => {
    expect(deliveryArtifactKey('del-1', new Date('2026-01-02T00:00:00Z'))).toBe(
      'v1/deliveries/2026-01-02/del-1/payload.json',
    );
    expect(runArtifactKey('job', 'run', 'result', 'md')).toBe('v1/runs/job/run/result.md');
    expect(repoConfigCacheKey(10)).toBe('v1:repo-config:10');
  });

  it('builds deterministic pr-card (KV) and pr-context (R2) keys', () => {
    // pr-card is keyed by (repo, pr) ONLY — so a command handler reads the
    // latest gathered shape without knowing the head SHA upfront.
    expect(prCardKey(10, 7)).toBe('v1:pr-card:10:7');
    // context keys are keyed per PR (repo, pr, kind) — NOT per head.
    expect(prContextKey(10, 7, 'manifest')).toBe('v1/prs/10/7/context/manifest.json');
    expect(prContextKey(10, 7, 'diff')).toBe('v1/prs/10/7/context/diff.diff');
    expect(prContextKey(10, 7, 'description')).toBe('v1/prs/10/7/context/description.md');
    expect(prContextV2Key(10, 7, 'manifest')).toBe('v2/prs/10/7/context/manifest.json');
    expect(prContextV2DiffKey(10, 7, 'src/cache.ts')).toBe(
      'v2/prs/10/7/context/diffs/src%2Fcache.ts.patch',
    );
  });

  it('builds a per-command result key under the same /context/ prefix (overwrite)', () => {
    // One object per (repo, PR, command); re-running a command overwrites it.
    expect(prCommandResultKey(10, 7, 'review')).toBe('v1/prs/10/7/context/review.md');
    expect(prCommandResultKey(10, 7, 'describe')).toBe('v1/prs/10/7/context/describe.md');
  });

  it('rejects unsafe key components and unknown context kinds', () => {
    expect(() => runArtifactKey('1/2', 'run', 'result', 'md')).toThrow('storage key component');
    expect(() => prCardKey('../x', 7)).toThrow('storage key component');
    expect(() => prContextKey(10, 7, 'bogus')).toThrow('Invalid PR context kind');
    expect(() => prContextV2Key(10, 7, 'diff')).toThrow('Invalid V2 PR context kind');
    expect(() => prContextV2DiffKey(10, 7, '../secret')).toThrow('repository-relative path');
    expect(() => normalizeRepositoryPath('/src/cache.ts')).toThrow('repository-relative path');
    expect(() => prCommandResultKey(10, 7, '../rev')).toThrow('storage key component');
  });
});

describe('PR storage event contract', () => {
  it('accepts only supported pull_request actions', () => {
    expect(isSupportedPullRequestEvent('pull_request', 'opened')).toBe(true);
    // Closed PRs do not introduce a new head and must not create a gather job.
    expect(isSupportedPullRequestEvent('pull_request', 'closed')).toBe(false);
    expect(isSupportedPullRequestEvent('issue_comment', 'opened')).toBe(false);
  });

  it('normalizes the GitHub payload to a small job record', () => {
    const event = extractPullRequestEvent(
      {
        action: 'opened',
        repository: { id: 10, name: 'repo', full_name: 'o/repo', owner: { login: 'o' } },
        pull_request: {
          number: 7,
          title: 'Title',
          state: 'open',
          user: { login: 'author' },
          head: { sha: 'abc' },
          base: { sha: 'def' },
        },
      },
      'delivery-1',
    );
    expect(event).toMatchObject({
      deliveryId: 'delivery-1',
      repositoryId: 10,
      prNumber: 7,
      headSha: 'abc',
      baseSha: 'def',
    });
  });
});
