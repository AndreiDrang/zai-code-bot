import { test, describe, expect } from 'vitest';
const {
  getEventType,
  isBotComment,
  shouldProcessEvent,
  getEventInfo,
  extractReviewCommentAnchor,
} = require('../src/lib/events.js');

describe('getEventType', () => {
  test('returns pull_request for pull_request event', () => {
    const context = { eventName: 'pull_request', payload: {} };
    expect(getEventType(context)).toBe('pull_request');
  });

  test('returns issue_comment_pr for issue_comment on PR', () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: {
          pull_request: { url: 'https://api.github.com/repos/octocat/Hello-World/pulls/42' },
        },
      },
    };
    expect(getEventType(context)).toBe('issue_comment_pr');
  });

  test('returns issue_comment_non_pr for issue_comment on issue', () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 42 },
      },
    };
    expect(getEventType(context)).toBe('issue_comment_non_pr');
  });

  test('returns issue_comment_non_pr for unknown event', () => {
    const context = { eventName: 'push', payload: {} };
    expect(getEventType(context)).toBe('issue_comment_non_pr');
  });
});

describe('isBotComment', () => {
  test('returns true for bot user', () => {
    const comment = { user: { type: 'Bot', login: 'github-actions[bot]' } };
    expect(isBotComment(comment)).toBe(true);
  });

  test('returns false for regular user', () => {
    const comment = { user: { type: 'User', login: 'octocat' } };
    expect(isBotComment(comment)).toBe(false);
  });

  test('returns false for missing user', () => {
    expect(isBotComment({})).toBe(false);
    expect(isBotComment(null)).toBe(false);
    expect(isBotComment(undefined)).toBe(false);
  });
});

describe('shouldProcessEvent', () => {
  test('processes pull_request events', () => {
    const context = {
      eventName: 'pull_request',
      payload: { pull_request: { number: 42 } },
    };
    const result = shouldProcessEvent(context);
    expect(result.process).toBe(true);
    expect(result.reason).toBe('pull_request event');
  });

  test('processes issue_comment on PR from user', () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/octocat/Hello-World/pulls/42' },
        },
        comment: { user: { type: 'User', login: 'octocat' } },
      },
    };
    const result = shouldProcessEvent(context);
    expect(result.process).toBe(true);
    expect(result.reason).toBe('issue_comment on pull request');
  });

  test('rejects issue_comment on PR from bot', () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/octocat/Hello-World/pulls/42' },
        },
        comment: { user: { type: 'Bot', login: 'github-actions[bot]' } },
      },
    };
    const result = shouldProcessEvent(context);
    expect(result.process).toBe(false);
    expect(result.reason).toBe('bot comment - skipping to prevent loop');
  });

  test('rejects non-PR issue comments', () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 42 },
        comment: { user: { type: 'User', login: 'octocat' } },
      },
    };
    const result = shouldProcessEvent(context);
    expect(result.process).toBe(false);
    expect(result.reason).toBe('non-PR issue comment - not supported');
  });

  test('rejects unknown event types', () => {
    const context = {
      eventName: 'push',
      payload: {},
    };
    const result = shouldProcessEvent(context);
    expect(result.process).toBe(false);
    expect(result.reason).toBe('non-PR issue comment - not supported');
  });
});

describe('getEventInfo', () => {
  test('extracts info from pull_request event', () => {
    const context = {
      eventName: 'pull_request',
      payload: { pull_request: { number: 42 } },
    };
    const info = getEventInfo(context);
    expect(info.eventType).toBe('pull_request');
    expect(info.shouldProcess).toBe(true);
    expect(info.pullNumber).toBe(42);
  });

  test('extracts comment info from issue_comment', () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/octocat/Hello-World/pulls/42' },
        },
        comment: {
          id: 123,
          user: { type: 'User', login: 'octocat' },
        },
      },
    };
    const info = getEventInfo(context);
    expect(info.commentId).toBe(123);
    expect(info.commentAuthor).toBe('octocat');
    expect(info.isBot).toBe(false);
  });

  test('detects bot comment in getEventInfo', () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/octocat/Hello-World/pulls/42' },
        },
        comment: {
          id: 456,
          user: { type: 'Bot', login: 'github-actions[bot]' },
        },
      },
    };
    const info = getEventInfo(context);
    expect(info.isBot).toBe(true);
    expect(info.shouldProcess).toBe(false);
  });
});

describe('extractReviewCommentAnchor', () => {
  test('returns anchor when path, line, and body present', () => {
    const payload = {
      comment: {
        path: 'src/index.js',
        line: 42,
        diff_hunk: '@@ -1,3 +1,4 @@',
        body: 'Fix this line',
      },
    };
    const result = extractReviewCommentAnchor(payload);
    expect(result).toEqual({
      commentPath: 'src/index.js',
      commentLine: 42,
      commentStartLine: null,
      commentDiffHunk: '@@ -1,3 +1,4 @@',
    });
  });

  test('returns anchor with start_line when present', () => {
    const payload = {
      comment: {
        path: 'src/index.js',
        line: 50,
        start_line: 45,
        body: 'Multi-line comment',
      },
    };
    const result = extractReviewCommentAnchor(payload);
    expect(result.commentLine).toBe(50);
    expect(result.commentStartLine).toBe(45);
  });

  test('returns null when missing path', () => {
    const payload = {
      comment: {
        line: 42,
        body: 'Comment without path',
      },
    };
    const result = extractReviewCommentAnchor(payload);
    expect(result).toBe(null);
  });

  test('returns null when missing comment entirely', () => {
    const payload = {};
    const result = extractReviewCommentAnchor(payload);
    expect(result).toBe(null);
  });

  test('returns null when not a review comment payload', () => {
    const payload = {
      issue: { number: 42 },
      comment: { id: 100, body: 'Regular comment' },
    };
    const result = extractReviewCommentAnchor(payload);
    expect(result).toBe(null);
  });
});
