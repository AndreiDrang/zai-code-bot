import { describe, expect, it } from 'vitest';

// Pure unit tests for the PR-preview event gate. These run the REAL predicate
// (no mocks) so the edited/title gate is actually exercised — the bug was that
// `edited` was absent from the whitelist, so a title change never became a job.

import {
  SUPPORTED_PR_ACTIONS,
  isSupportedPullRequestEvent,
  extractPullRequestEvent,
} from '../zai-main-worker/src/pr-events.js';

describe('isSupportedPullRequestEvent', () => {
  it('whitelists edited and closed', () => {
    expect(SUPPORTED_PR_ACTIONS).toContain('edited');
    expect(SUPPORTED_PR_ACTIONS).toContain('closed');
  });

  it('accepts the always-supported actions without a payload', () => {
    for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review', 'closed']) {
      expect(isSupportedPullRequestEvent('pull_request', action)).toBe(true);
    }
  });

  it('accepts an edited event only when the title changed', () => {
    expect(
      isSupportedPullRequestEvent('pull_request', 'edited', {
        changes: { title: { from: 'Cloudflare migration' } },
      }),
    ).toBe(true);
  });

  it('rejects an edited event when only the body changed (no wasteful re-render)', () => {
    expect(
      isSupportedPullRequestEvent('pull_request', 'edited', {
        changes: { body: { from: 'old body' } },
      }),
    ).toBe(false);
  });

  it('rejects an edited event when only the base branch changed', () => {
    expect(
      isSupportedPullRequestEvent('pull_request', 'edited', {
        changes: { base: { ref: { from: 'main' } } },
      }),
    ).toBe(false);
  });

  it('rejects an edited event with no changes block (defensive)', () => {
    expect(isSupportedPullRequestEvent('pull_request', 'edited', {})).toBe(false);
    expect(isSupportedPullRequestEvent('pull_request', 'edited')).toBe(false);
  });

  it('rejects unsupported actions', () => {
    expect(isSupportedPullRequestEvent('pull_request', 'labeled')).toBe(false);
    expect(isSupportedPullRequestEvent('pull_request', 'assigned')).toBe(false);
  });

  it('rejects non-pull_request events', () => {
    expect(isSupportedPullRequestEvent('issue_comment', 'created')).toBe(false);
    expect(isSupportedPullRequestEvent('pull_request_review_comment', 'created')).toBe(false);
  });
});

describe('extractPullRequestEvent', () => {
  // Mirrors the real webhook payload shape for PR #43 title edit.
  function basePayload(overrides = {}) {
    return {
      action: 'edited',
      changes: { title: { from: 'Cloudflare migration' } },
      repository: {
        id: 1164298160,
        name: 'zai-code-bot',
        full_name: 'AndreiDrang/zai-code-bot',
        default_branch: 'main',
        owner: { login: 'AndreiDrang' },
      },
      pull_request: {
        number: 43,
        title: 'To cloudflare migration',
        state: 'open',
        head: { sha: '20b7910be777ee55f7ca355cfeabb5167cc1aa39' },
        base: { sha: '8009db78cb47a226dc15626acf3f40f06e047f23' },
        user: { login: 'AndreiDrang' },
      },
      ...overrides,
    };
  }

  it('extracts the NEW title and head SHA from an edited event', () => {
    const event = extractPullRequestEvent(basePayload(), 'delivery-43-edit');
    expect(event).toMatchObject({
      deliveryId: 'delivery-43-edit',
      action: 'edited',
      repositoryId: 1164298160,
      prNumber: 43,
      title: 'To cloudflare migration',
      headSha: '20b7910be777ee55f7ca355cfeabb5167cc1aa39',
      authorLogin: 'AndreiDrang',
      state: 'open',
    });
    expect(event.repository.fullName).toBe('AndreiDrang/zai-code-bot');
  });

  it('returns null when the payload is incomplete', () => {
    expect(extractPullRequestEvent({}, 'delivery-1')).toBeNull();
    expect(extractPullRequestEvent(basePayload(), '')).toBeNull();
  });

  it('extracts state=closed and closedBy=sender from a closed event', () => {
    const closedPayload = {
      ...basePayload(),
      action: 'closed',
      pull_request: { ...basePayload().pull_request, state: 'closed' },
      sender: { login: 'AndreiDrang' },
    };
    const event = extractPullRequestEvent(closedPayload, 'delivery-43-closed', 'closed');
    expect(event.state).toBe('closed');
    expect(event.closedBy).toBe('AndreiDrang');
    expect(event.authorLogin).toBe('AndreiDrang');
    expect(event.action).toBe('closed');
  });

  it('does not populate closedBy for non-close actions', () => {
    // opened/synchronize carry a sender too, but only `closed` sets closedBy.
    const opened = extractPullRequestEvent(
      { ...basePayload(), action: 'opened', sender: { login: 'someone' } },
      'delivery-1',
      'opened',
    );
    expect(opened.closedBy).toBeNull();
    const sync = extractPullRequestEvent(
      { ...basePayload(), action: 'synchronize', sender: { login: 'someone' } },
      'delivery-2',
      'synchronize',
    );
    expect(sync.closedBy).toBeNull();
  });
});
