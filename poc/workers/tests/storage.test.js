import { describe, expect, it, vi } from 'vitest';
import {
  deliveryArtifactKey,
  jobStatusCacheKey,
  prPreviewCacheKey,
  prFilesArtifactKey,
  repoConfigCacheKey,
  runArtifactKey,
} from '../shared/storage/keys.js';
import { fetchPrStats } from '../shared/pr-stats.js';
import { renderPrPreview } from '../shared/pr-preview.js';
import {
  extractPullRequestEvent,
  isSupportedPullRequestEvent,
} from '../zai-main-worker/src/pr-events.js';

describe('storage key contracts', () => {
  it('creates versioned keys for bot-storage and bot-cache consumers', () => {
    expect(deliveryArtifactKey('del-1', new Date('2026-01-02T00:00:00Z'))).toBe(
      'v1/deliveries/2026-01-02/del-1/payload.json',
    );
    expect(prFilesArtifactKey(10, 7, 'abc')).toBe('v1/pr/10/7/abc/files.json');
    expect(runArtifactKey('job', 'run', 'result', 'md')).toBe('v1/runs/job/run/result.md');
    expect(repoConfigCacheKey(10, 2)).toBe('v1:repo-config:10:2');
    expect(prPreviewCacheKey(10, 7, 'abc')).toBe('v1:pr-preview:10:7:abc');
    expect(jobStatusCacheKey('job')).toBe('v1:job-status:job');
  });

  it('rejects unsafe key components', () => {
    expect(() => prPreviewCacheKey(1, 2, '../secret')).toThrow('storage key component');
  });
});

describe('PR storage event contract', () => {
  it('accepts only supported pull_request actions', () => {
    expect(isSupportedPullRequestEvent('pull_request', 'opened')).toBe(true);
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

describe('PR statistics and preview', () => {
  it('paginates files and returns bounded aggregate statistics', async () => {
    const github = {
      getPrFiles: vi
        .fn()
        .mockResolvedValueOnce(
          Array.from({ length: 100 }, (_, index) => ({
            filename: `file-${index}.js`,
            additions: index === 0 ? 2 : 0,
            deletions: index === 0 ? 1 : 0,
            status: 'modified',
          })),
        )
        .mockResolvedValueOnce(
          Array.from({ length: 10 }, (_, index) => ({
            filename: `extra-${index}.js`,
            additions: 0,
            deletions: 0,
            status: 'added',
          })),
        ),
    };
    await expect(fetchPrStats(github, 'o', 'r', 7, { maxFiles: 110 })).resolves.toMatchObject({
      additions: 2,
      deletions: 1,
      changedFiles: 110,
      truncated: true,
    });
    expect(github.getPrFiles).toHaveBeenCalledTimes(2);
  });

  it('renders escaped, marker-idempotent markdown', () => {
    const body = renderPrPreview({
      repository: 'o/repo',
      prNumber: 7,
      headSha: 'abc',
      title: 'A | title',
      authorLogin: 'user',
      stats: {
        additions: 2,
        deletions: 1,
        changedFiles: 1,
        truncated: true,
        files: [{ filename: 'a|b.js', additions: 2, deletions: 1, status: 'modified' }],
      },
    });
    expect(body).toContain('A \\| title');
    expect(body).toContain('a\\|b.js');
    expect(body).toContain('<!-- zai-pr-preview -->');
    expect(body).toContain('File list truncated');
  });
});
