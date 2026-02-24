const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
  isCollaborator,
  checkAuthorization,
  checkForkAuthorization,
  isForkPullRequest,
  getUnauthorizedMessage,
  getUnknownCommandMessage,
  AUTHORIZED_PERMISSIONS,
} = require('../src/lib/auth');

function createMockOctokit(permission, shouldThrow = false, errorStatus = null, pullRequestData = null) {
  return {
    rest: {
      repos: {
        getCollaboratorPermission: async () => {
          if (shouldThrow) {
            const error = new Error('API Error');
            error.status = errorStatus || 404;
            throw error;
          }
          return {
            data: { permission },
          };
        },
      },
      pulls: {
        get: async () => ({
          data: pullRequestData || {
            head: { repo: { fork: false } },
            user: { login: 'pr-author' },
          },
        }),
      },
    },
  };
}

function createMockContext(prIsFork = false, pullRequest = null) {
  return {
    repo: {
      owner: 'test-owner',
      repo: 'test-repo',
    },
    payload: {
      pull_request: pullRequest || {
        head: {
          repo: {
            fork: prIsFork,
          },
        },
      },
    },
  };
}

describe('isCollaborator', () => {
  test('returns true for admin permission', async () => {
    const octokit = createMockOctokit('admin');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    assert.strictEqual(result.isCollaborator, true);
    assert.strictEqual(result.permission, 'admin');
  });

  test('returns true for maintain permission', async () => {
    const octokit = createMockOctokit('maintain');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    assert.strictEqual(result.isCollaborator, true);
    assert.strictEqual(result.permission, 'maintain');
  });

  test('returns true for write permission', async () => {
    const octokit = createMockOctokit('write');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    assert.strictEqual(result.isCollaborator, true);
    assert.strictEqual(result.permission, 'write');
  });

  test('returns true for read permission', async () => {
    const octokit = createMockOctokit('read');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    assert.strictEqual(result.isCollaborator, true);
    assert.strictEqual(result.permission, 'read');
  });

  test('returns false for triage permission', async () => {
    const octokit = createMockOctokit('triage');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    assert.strictEqual(result.isCollaborator, false);
    assert.strictEqual(result.permission, 'triage');
  });

  test('returns false for none permission', async () => {
    const octokit = createMockOctokit('none');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    assert.strictEqual(result.isCollaborator, false);
    assert.strictEqual(result.permission, 'none');
  });

  test('handles 404 error - not a collaborator', async () => {
    const octokit = createMockOctokit(null, true, 404);
    const result = await isCollaborator(octokit, 'owner', 'repo', 'unknown-user');
    assert.strictEqual(result.isCollaborator, false);
    assert.strictEqual(result.permission, null);
  });

  test('re-throws 403 error for caller to handle safely', async () => {
    const octokit = createMockOctokit(null, true, 403);
    await assert.rejects(
      isCollaborator(octokit, 'owner', 'repo', 'unknown-user'),
      (error) => error.status === 403
    );
  });

  test('re-throws non-404/403 errors', async () => {
    const octokit = createMockOctokit(null, true, 500);
    await assert.rejects(
      isCollaborator(octokit, 'owner', 'repo', 'user1'),
      (error) => error.status === 500
    );
  });
});

describe('checkAuthorization', () => {
  test('returns authorized for collaborator', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext();
    const commenter = { login: 'collaborator-user' };

    const result = await checkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, true);
    assert.strictEqual(result.reason, undefined);
  });

  test('returns unauthorized for non-collaborator', async () => {
    const octokit = createMockOctokit('none');
    const context = createMockContext();
    const commenter = { login: 'random-user' };

    const result = await checkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, 'You are not authorized to use this command.');
  });

  test('returns unauthorized for null commenter', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext();
    const commenter = null;

    const result = await checkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, 'Unable to identify commenter');
  });

  test('returns unauthorized for commenter without login', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext();
    const commenter = {};

    const result = await checkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, 'Unable to identify commenter');
  });

  test('denies access on API error for security', async () => {
    const octokit = createMockOctokit(null, true, 500);
    const context = createMockContext();
    const commenter = { login: 'some-user' };

    const result = await checkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, 'Authorization check failed. Please try again later.');
  });

  test('returns auth-check-failed for 403 permission errors', async () => {
    const octokit = createMockOctokit(null, true, 403);
    const context = createMockContext();
    const commenter = { login: 'some-user' };

    const result = await checkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, 'Authorization check failed. Please try again later.');
  });
});

describe('isForkPullRequest', () => {
  test('returns true for fork PR', () => {
    const pullRequest = {
      head: {
        repo: {
          fork: true,
        },
      },
    };
    assert.strictEqual(isForkPullRequest(pullRequest), true);
  });

  test('returns false for non-fork PR', () => {
    const pullRequest = {
      head: {
        repo: {
          fork: false,
        },
      },
    };
    assert.strictEqual(isForkPullRequest(pullRequest), false);
  });

  test('returns false for null PR', () => {
    assert.strictEqual(isForkPullRequest(null), false);
  });

  test('returns false for missing head.repo', () => {
    assert.strictEqual(isForkPullRequest({}), false);
  });
});

describe('checkForkAuthorization', () => {
  test('allows collaborator on regular PR', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext(false);
    const commenter = { login: 'collaborator' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, true);
  });

  test('blocks non-collaborator on regular PR with message', async () => {
    const octokit = createMockOctokit('none');
    const context = createMockContext(false);
    const commenter = { login: 'random-user' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, 'You are not authorized to use this command.');
  });

  test('allows collaborator on fork PR', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext(true);
    const commenter = { login: 'collaborator' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, true);
  });

  test('allows fork PR creator even without collaborator permission', async () => {
    const pullRequest = {
      head: { repo: { fork: true } },
      user: { login: 'pr-creator' },
    };
    const octokit = createMockOctokit('none');
    const context = createMockContext(true, pullRequest);
    const commenter = { login: 'pr-creator' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, true);
  });

  test('blocks non-collaborator on fork PR silently', async () => {
    const octokit = createMockOctokit('none');
    const context = createMockContext(true);
    const commenter = { login: 'random-user' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, null);
  });

  test('blocks anonymous user on fork PR silently', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext(true);
    const commenter = null;

    const result = await checkForkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, false);
    assert.strictEqual(result.reason, null);
  });

  test('allows issue_comment fork PR creator when PR details are fetched', async () => {
    const pullRequestData = {
      head: { repo: { fork: true } },
      user: { login: 'fork-author' },
    };
    const octokit = createMockOctokit('none', false, null, pullRequestData);
    const context = {
      repo: { owner: 'test-owner', repo: 'test-repo' },
      payload: {
        issue: {
          number: 123,
          pull_request: { url: 'https://api.github.test/pulls/123' },
        },
      },
    };
    const commenter = { login: 'fork-author' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    assert.strictEqual(result.authorized, true);
  });
});

describe('getUnauthorizedMessage', () => {
  test('returns safe error message', () => {
    const message = getUnauthorizedMessage();
    assert.strictEqual(message, 'You are not authorized to use this command.');
  });

  test('does not expose internal details', () => {
    const message = getUnauthorizedMessage();
    assert.ok(!message.includes('token'));
    assert.ok(!message.includes('API'));
    assert.ok(!message.includes('error'));
  });
});

describe('getUnknownCommandMessage', () => {
  test('returns unknown command message', () => {
    const message = getUnknownCommandMessage();
    assert.strictEqual(message, "Unknown command. Use /zai help for available commands.");
  });
});

describe('AUTHORIZED_PERMISSIONS', () => {
  test('contains expected permission levels', () => {
    assert.ok(AUTHORIZED_PERMISSIONS.has('admin'));
    assert.ok(AUTHORIZED_PERMISSIONS.has('maintain'));
    assert.ok(AUTHORIZED_PERMISSIONS.has('write'));
    assert.ok(AUTHORIZED_PERMISSIONS.has('read'));
  });

  test('does not contain triage or none', () => {
    assert.ok(!AUTHORIZED_PERMISSIONS.has('triage'));
    assert.ok(!AUTHORIZED_PERMISSIONS.has('none'));
  });
});
