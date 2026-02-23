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

function createMockOctokit(permission, shouldThrow = false, errorStatus = null) {
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

  test('handles 403 error - not a collaborator', async () => {
    const octokit = createMockOctokit(null, true, 403);
    const result = await isCollaborator(octokit, 'owner', 'repo', 'unknown-user');
    assert.strictEqual(result.isCollaborator, false);
    assert.strictEqual(result.permission, null);
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
