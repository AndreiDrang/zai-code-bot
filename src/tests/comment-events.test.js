import { describe, expect, it } from 'vitest';

// Pure unit tests for the issue_comment → comments-slice-refresh classification.
// These run the REAL predicates (no mocks): the guard must fire only for PR
// conversation comments with a write-capable env.

import {
  COMMENT_REFRESH_ACTIONS,
  isPrCommentRefreshEvent,
  planCommentsRefresh,
} from '../zai-main-worker/src/comment-events.js';

const env = { BOT_ARTIFACTS: {} };

/** A PR-bearing issue_comment webhook slice, parametrized by action. */
function prCommentEvent(action, overrides = {}) {
  return {
    action,
    repository: { id: 10, name: 'r', owner: { login: 'o' } },
    issue: { number: 7, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/7' } },
    ...overrides,
  };
}

describe('isPrCommentRefreshEvent', () => {
  it('accepts created / edited / deleted on a PR conversation comment', () => {
    expect(COMMENT_REFRESH_ACTIONS).toEqual(['created', 'edited', 'deleted']);
    for (const action of COMMENT_REFRESH_ACTIONS) {
      expect(isPrCommentRefreshEvent('issue_comment', prCommentEvent(action), env)).toBe(true);
    }
  });

  it('rejects a plain-issue comment (no pull_request on the issue)', () => {
    const issueOnly = {
      action: 'created',
      repository: { id: 10, name: 'r', owner: { login: 'o' } },
      issue: { number: 7 }, // no pull_request → not a PR
    };
    expect(isPrCommentRefreshEvent('issue_comment', issueOnly, env)).toBe(false);
  });

  it('rejects actions outside the refresh set', () => {
    expect(isPrCommentRefreshEvent('issue_comment', prCommentEvent('locked'), env)).toBe(false);
  });

  it('rejects non-issue_comment events (PR events, inline review comments)', () => {
    expect(isPrCommentRefreshEvent('pull_request', prCommentEvent('opened'), env)).toBe(false);
    expect(
      isPrCommentRefreshEvent('pull_request_review_comment', prCommentEvent('created'), env),
    ).toBe(false);
  });

  it('rejects when R2 is not bound (no point fetching with nowhere to write)', () => {
    expect(isPrCommentRefreshEvent('issue_comment', prCommentEvent('created'), {})).toBe(false);
  });
});

describe('planCommentsRefresh', () => {
  it('extracts owner / name / prNumber / repoId from the webhook', () => {
    expect(planCommentsRefresh(prCommentEvent('created'))).toEqual({
      owner: 'o',
      name: 'r',
      prNumber: 7,
      repoId: 10,
    });
  });

  it('returns null when any part of the identity is incomplete', () => {
    // no owner
    expect(
      planCommentsRefresh({ ...prCommentEvent('created'), repository: { id: 10, name: 'r' } }),
    ).toBeNull();
    // no name
    expect(
      planCommentsRefresh({
        ...prCommentEvent('created'),
        repository: { id: 10, owner: { login: 'o' } },
      }),
    ).toBeNull();
    // no repoId
    expect(
      planCommentsRefresh({
        ...prCommentEvent('created'),
        repository: { name: 'r', owner: { login: 'o' } },
      }),
    ).toBeNull();
    // no PR number
    expect(planCommentsRefresh({ ...prCommentEvent('created'), issue: {} })).toBeNull();
  });
});
