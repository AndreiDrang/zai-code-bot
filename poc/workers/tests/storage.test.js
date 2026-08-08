import { describe, expect, it } from 'vitest';
import {
  deliveryArtifactKey,
  prCardKey,
  prCommandResultKey,
  prContextKey,
  repoConfigCacheKey,
  runArtifactKey,
} from '../shared/storage/keys.js';
import { renderPrPreview, renderPrClosed } from '../shared/pr-preview.js';
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
  });

  it('builds a per-command result key under the same /context/ prefix (overwrite)', () => {
    // One object per (repo, PR, command); re-running a command overwrites it.
    expect(prCommandResultKey(10, 7, 'review')).toBe('v1/prs/10/7/context/review.md');
    expect(prCommandResultKey(10, 7, 'impact')).toBe('v1/prs/10/7/context/impact.md');
  });

  it('rejects unsafe key components and unknown context kinds', () => {
    expect(() => runArtifactKey('1/2', 'run', 'result', 'md')).toThrow('storage key component');
    expect(() => prCardKey('../x', 7)).toThrow('storage key component');
    expect(() => prContextKey(10, 7, 'bogus')).toThrow('Invalid PR context kind');
    expect(() => prCommandResultKey(10, 7, '../rev')).toThrow('storage key component');
  });
});

describe('PR storage event contract', () => {
  it('accepts only supported pull_request actions', () => {
    expect(isSupportedPullRequestEvent('pull_request', 'opened')).toBe(true);
    expect(isSupportedPullRequestEvent('pull_request', 'closed')).toBe(true);
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

describe('PR preview rendering', () => {
  it('renders a metadata-only, marker-idempotent comment with escaped pipes', () => {
    const body = renderPrPreview({
      repository: 'o/repo',
      prNumber: 7,
      headSha: 'abc',
      title: 'A | title',
      authorLogin: 'user',
    });
    expect(body).toContain('## PR Preview');
    expect(body).toContain('| **PR** | #7 |');
    expect(body).toContain('| **Head** | `abc` |');
    expect(body).toContain('A \\| title');
    expect(body).toContain('<!-- zai-pr-preview -->');
    // No per-file or stat rows leak into the brief.
    expect(body).not.toContain('Files changed');
    expect(body).not.toContain('Lines added');
    expect(body).not.toContain('Lines deleted');
    expect(body).not.toContain('Changed Files');
  });
});

describe('PR closed rendering', () => {
  it('renders a marker-idempotent "closed by" lifecycle comment', () => {
    const body = renderPrClosed({ closedBy: 'AndreiDrang' });
    expect(body).toContain('## 🔒 PR Closed');
    expect(body).toContain('PR closed by @AndreiDrang');
    expect(body).toContain('<!-- zai-pr-closed -->');
    expect(body).toContain('Powered by');
  });

  it('falls back to unknown when closedBy is missing', () => {
    expect(renderPrClosed({})).toContain('@unknown');
  });
});
