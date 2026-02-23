const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  getEventType,
  isBotComment,
  shouldProcessEvent,
  getEventInfo,
} = require('../src/lib/events.js');

describe('getEventType', () => {
  test('returns pull_request for pull_request event', () => {
    const context = { eventName: 'pull_request', payload: {} };
    assert.strictEqual(getEventType(context), 'pull_request');
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
    assert.strictEqual(getEventType(context), 'issue_comment_pr');
  });

  test('returns issue_comment_non_pr for issue_comment on issue', () => {
    const context = {
      eventName: 'issue_comment',
      payload: {
        issue: { number: 42 },
      },
    };
    assert.strictEqual(getEventType(context), 'issue_comment_non_pr');
  });

  test('returns issue_comment_non_pr for unknown event', () => {
    const context = { eventName: 'push', payload: {} };
    assert.strictEqual(getEventType(context), 'issue_comment_non_pr');
  });
});

describe('isBotComment', () => {
  test('returns true for bot user', () => {
    const comment = { user: { type: 'Bot', login: 'github-actions[bot]' } };
    assert.strictEqual(isBotComment(comment), true);
  });

  test('returns false for regular user', () => {
    const comment = { user: { type: 'User', login: 'octocat' } };
    assert.strictEqual(isBotComment(comment), false);
  });

  test('returns false for missing user', () => {
    assert.strictEqual(isBotComment({}), false);
    assert.strictEqual(isBotComment(null), false);
    assert.strictEqual(isBotComment(undefined), false);
  });
});

describe('shouldProcessEvent', () => {
  test('processes pull_request events', () => {
    const context = {
      eventName: 'pull_request',
      payload: { pull_request: { number: 42 } },
    };
    const result = shouldProcessEvent(context);
    assert.strictEqual(result.process, true);
    assert.strictEqual(result.reason, 'pull_request event');
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
    assert.strictEqual(result.process, true);
    assert.strictEqual(result.reason, 'issue_comment on pull request');
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
    assert.strictEqual(result.process, false);
    assert.strictEqual(result.reason, 'bot comment - skipping to prevent loop');
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
    assert.strictEqual(result.process, false);
    assert.strictEqual(result.reason, 'non-PR issue comment - not supported');
  });

  test('rejects unknown event types', () => {
    const context = {
      eventName: 'push',
      payload: {},
    };
    const result = shouldProcessEvent(context);
    assert.strictEqual(result.process, false);
    assert.strictEqual(result.reason, 'non-PR issue comment - not supported');
  });
});

describe('getEventInfo', () => {
  test('extracts info from pull_request event', () => {
    const context = {
      eventName: 'pull_request',
      payload: { pull_request: { number: 42 } },
    };
    const info = getEventInfo(context);
    assert.strictEqual(info.eventType, 'pull_request');
    assert.strictEqual(info.shouldProcess, true);
    assert.strictEqual(info.pullNumber, 42);
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
    assert.strictEqual(info.commentId, 123);
    assert.strictEqual(info.commentAuthor, 'octocat');
    assert.strictEqual(info.isBot, false);
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
    assert.strictEqual(info.isBot, true);
    assert.strictEqual(info.shouldProcess, false);
  });
});
