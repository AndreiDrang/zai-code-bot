const {
  isCollaborator,
  checkAuthorization,
  checkForkAuthorization,
  isForkPullRequest,
  isRepoOwner,
  normalizeLogin,
  normalizeAssociation,
  getCommentAuthorAssociation,
  isTrustedCommentAuthor,
  getCommenter,
  getUnauthorizedMessage,
  getUnknownCommandMessage,
  AUTHORIZED_PERMISSIONS,
  AUTHORIZED_ASSOCIATIONS,
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
    expect(result.isCollaborator).toBe(true);
    expect(result.permission).toBe('admin');
  });

  test('returns true for maintain permission', async () => {
    const octokit = createMockOctokit('maintain');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    expect(result.isCollaborator).toBe(true);
    expect(result.permission).toBe('maintain');
  });

  test('returns true for write permission', async () => {
    const octokit = createMockOctokit('write');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    expect(result.isCollaborator).toBe(true);
    expect(result.permission).toBe('write');
  });

  test('returns true for read permission', async () => {
    const octokit = createMockOctokit('read');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    expect(result.isCollaborator).toBe(true);
    expect(result.permission).toBe('read');
  });

  test('returns false for triage permission', async () => {
    const octokit = createMockOctokit('triage');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    expect(result.isCollaborator).toBe(false);
    expect(result.permission).toBe('triage');
  });

  test('returns false for none permission', async () => {
    const octokit = createMockOctokit('none');
    const result = await isCollaborator(octokit, 'owner', 'repo', 'user1');
    expect(result.isCollaborator).toBe(false);
    expect(result.permission).toBe('none');
  });

  test('handles 404 error - not a collaborator', async () => {
    const octokit = createMockOctokit(null, true, 404);
    const result = await isCollaborator(octokit, 'owner', 'repo', 'unknown-user');
    expect(result.isCollaborator).toBe(false);
    expect(result.permission).toBe(null);
  });

  test('re-throws 403 error for caller to handle safely', async () => {
    const octokit = createMockOctokit(null, true, 403);
    await expect(
      isCollaborator(octokit, 'owner', 'repo', 'unknown-user')
    ).rejects.toThrow();
  });

  test('re-throws non-404/403 errors', async () => {
    const octokit = createMockOctokit(null, true, 500);
    await expect(
      isCollaborator(octokit, 'owner', 'repo', 'user1')
    ).rejects.toThrow();
  });
});

describe('checkAuthorization', () => {
  test('allows repository owner without collaborator lookup', async () => {
    const octokit = createMockOctokit(null, true, 404);
    const context = createMockContext();
    const commenter = { login: 'test-owner' };

    const result = await checkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
  });

  test('allows repository owner with case-insensitive login match', async () => {
    const octokit = createMockOctokit(null, true, 404);
    const context = createMockContext();
    const commenter = { login: 'Test-Owner' };

    const result = await checkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
  });

  test('allows trusted author association without collaborator lookup', async () => {
    const octokit = createMockOctokit(null, true, 403);
    const context = createMockContext();
    context.payload.comment = { author_association: 'MEMBER' };
    const commenter = { login: 'org-member' };

    const result = await checkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
  });

  test('allows contributor association without collaborator lookup', async () => {
    const octokit = createMockOctokit('none');
    const context = createMockContext();
    context.payload.comment = { author_association: 'CONTRIBUTOR' };
    const commenter = { login: 'thread-author' };

    const result = await checkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
  });

  test('returns authorized for collaborator', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext();
    const commenter = { login: 'collaborator-user' };

    const result = await checkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
  });

  test('returns unauthorized for non-collaborator', async () => {
    const octokit = createMockOctokit('none');
    const context = createMockContext();
    const commenter = { login: 'random-user' };

    const result = await checkAuthorization(octokit, context, commenter);
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
  });

  test('returns unauthorized for null commenter', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext();
    const commenter = null;

    const result = await checkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('Unable to identify commenter');
  });

  test('returns unauthorized for commenter without login', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext();
    const commenter = {};

    const result = await checkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('Unable to identify commenter');
  });

  test('denies access on API error for security', async () => {
    const octokit = createMockOctokit(null, true, 500);
    const context = createMockContext();
    const commenter = { login: 'some-user' };

    const result = await checkAuthorization(octokit, context, commenter);
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
  });

  test('returns auth-check-failed for 403 permission errors', async () => {
    const octokit = createMockOctokit(null, true, 403);
    const context = createMockContext();
    const commenter = { login: 'some-user' };

    const result = await checkAuthorization(octokit, context, commenter);
    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
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
    expect(isForkPullRequest(pullRequest)).toBe(true);
  });

  test('returns false for non-fork PR', () => {
    const pullRequest = {
      head: {
        repo: {
          fork: false,
        },
      },
    };
    expect(isForkPullRequest(pullRequest)).toBe(false);
  });

  test('returns false for null PR', () => {
    expect(isForkPullRequest(null)).toBe(false);
  });

  test('returns false for missing head.repo', () => {
    expect(isForkPullRequest({})).toBe(false);
  });
});

describe('checkForkAuthorization', () => {
  test('allows repository owner on regular PR', async () => {
    const octokit = createMockOctokit('none');
    const context = createMockContext(false);
    const commenter = { login: 'test-owner' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
    expect(result.reason).toBe('identifiable_user');
  });

  test('allows collaborator on regular PR', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext(false);
    const commenter = { login: 'collaborator' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
  });

  test('allows any user on regular PR (permissive)', async () => {
    const octokit = createMockOctokit('none');
    const context = createMockContext(false);
    const commenter = { login: 'random-user' };
    const result = await checkForkAuthorization(octokit, context, commenter);
    expect(result.authorized).toBe(true);
  });

  test('allows collaborator on fork PR', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext(true);
    const commenter = { login: 'collaborator' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
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

    expect(result.authorized).toBe(true);
  });

  test('allows repository owner on fork PR (e.g., Dependabot)', async () => {
    const pullRequest = {
      head: { repo: { fork: true } },
      user: { login: 'dependabot[bot]' },
    };
    const octokit = createMockOctokit('none');
    const context = createMockContext(true, pullRequest);
    const commenter = { login: 'test-owner' };

    const result = await checkForkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(true);
  });

  test('allows any user on fork PR (permissive)', async () => {
    const octokit = createMockOctokit('none');
    const context = createMockContext(true);
    const commenter = { login: 'random-user' };
    const result = await checkForkAuthorization(octokit, context, commenter);
    expect(result.authorized).toBe(true);
  });

  test('blocks anonymous user on fork PR silently', async () => {
    const octokit = createMockOctokit('write');
    const context = createMockContext(true);
    const commenter = null;

    const result = await checkForkAuthorization(octokit, context, commenter);

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe(null);
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

    expect(result.authorized).toBe(true);
  });
});

describe('getUnauthorizedMessage', () => {
  test('returns safe error message', () => {
    const message = getUnauthorizedMessage();
    expect(message).toBe('You are not authorized to use this command.');
  });

  test('returns specific guidance when commenter cannot be identified', () => {
    const message = getUnauthorizedMessage('Unable to identify commenter');
    expect(message).toContain('Unable to identify who authored this command comment');
  });

  test('returns specific guidance for temporary auth verification failures', () => {
    const message = getUnauthorizedMessage('Authorization check failed. Please try again later.');
    expect(message).toContain('Authorization could not be verified');
  });

  test('returns association-specific denial details when available', () => {
    const message = getUnauthorizedMessage('Authorization denied (author_association: NONE).');
    expect(message).toContain('author_association: NONE');
    expect(message).toContain('Allowed associations: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR');
  });

  test('does not expose internal details', () => {
    const message = getUnauthorizedMessage();
    expect(message).not.toContain('token');
    expect(message).not.toContain('API');
    expect(message).not.toContain('error');
  });
});

describe('getUnknownCommandMessage', () => {
  test('returns unknown command message', () => {
    const message = getUnknownCommandMessage();
    expect(message).toBe("Unknown command. Use /zai help for available commands.");
  });
});

describe('AUTHORIZED_PERMISSIONS', () => {
  test('contains expected permission levels', () => {
    expect(AUTHORIZED_PERMISSIONS.has('admin')).toBe(true);
    expect(AUTHORIZED_PERMISSIONS.has('maintain')).toBe(true);
    expect(AUTHORIZED_PERMISSIONS.has('write')).toBe(true);
    expect(AUTHORIZED_PERMISSIONS.has('read')).toBe(true);
  });

  test('does not contain triage or none', () => {
    expect(AUTHORIZED_PERMISSIONS.has('triage')).toBe(false);
    expect(AUTHORIZED_PERMISSIONS.has('none')).toBe(false);
  });
});

describe('normalizeLogin', () => {
  test('normalizes casing and trims whitespace', () => {
    expect(normalizeLogin('  Test-Owner  ')).toBe('test-owner');
  });

  test('returns empty string for invalid input', () => {
    expect(normalizeLogin(null)).toBe('');
    expect(normalizeLogin(undefined)).toBe('');
  });
});

describe('isRepoOwner', () => {
  test('matches context.repo.owner case-insensitively', () => {
    const context = createMockContext();
    expect(isRepoOwner(context, 'Test-Owner')).toBe(true);
  });

  test('matches payload.repository.owner.login when available', () => {
    const context = createMockContext();
    context.payload.repository = { owner: { login: 'Alt-Owner' } };
    expect(isRepoOwner(context, 'alt-owner')).toBe(true);
  });

  test('returns false for non-owner login', () => {
    const context = createMockContext();
    expect(isRepoOwner(context, 'another-user')).toBe(false);
  });
});

describe('normalizeAssociation', () => {
  test('normalizes casing and trims whitespace', () => {
    expect(normalizeAssociation('  collaborator  ')).toBe('COLLABORATOR');
  });

  test('returns empty string for invalid input', () => {
    expect(normalizeAssociation(null)).toBe('');
  });
});

describe('getCommentAuthorAssociation', () => {
  test('prefers commenter association when present', () => {
    const context = createMockContext();
    context.payload.comment = { author_association: 'NONE' };
    const commenter = { author_association: 'MEMBER' };
    expect(getCommentAuthorAssociation(context, commenter)).toBe('MEMBER');
  });

  test('falls back to payload comment association', () => {
    const context = createMockContext();
    context.payload.comment = { author_association: 'OWNER' };
    expect(getCommentAuthorAssociation(context, { login: 'user' })).toBe('OWNER');
  });
});

describe('getCommenter', () => {
  test('returns comment user when available', () => {
    const context = createMockContext();
    context.payload.comment = { user: { login: 'comment-user' } };
    context.payload.sender = { login: 'sender-user' };

    const commenter = getCommenter(context);
    expect(commenter.login).toBe('comment-user');
  });

  test('falls back to sender when comment user is missing', () => {
    const context = createMockContext();
    context.payload.comment = { body: '/zai explain' };
    context.payload.sender = { login: 'sender-user' };

    const commenter = getCommenter(context);
    expect(commenter.login).toBe('sender-user');
  });

  test('uses review user when comment and sender are missing', () => {
    const context = createMockContext();
    context.payload.comment = null;
    context.payload.sender = null;
    context.payload.review = { user: { login: 'review-user' } };

    const commenter = getCommenter(context);
    expect(commenter.login).toBe('review-user');
  });
});

describe('isTrustedCommentAuthor', () => {
  test('returns true for OWNER, MEMBER, COLLABORATOR, and CONTRIBUTOR', () => {
    const context = createMockContext();
    context.payload.comment = { author_association: 'OWNER' };
    expect(isTrustedCommentAuthor(context, { login: 'u1' })).toBe(true);

    context.payload.comment = { author_association: 'MEMBER' };
    expect(isTrustedCommentAuthor(context, { login: 'u2' })).toBe(true);

    context.payload.comment = { author_association: 'COLLABORATOR' };
    expect(isTrustedCommentAuthor(context, { login: 'u3' })).toBe(true);

    context.payload.comment = { author_association: 'CONTRIBUTOR' };
    expect(isTrustedCommentAuthor(context, { login: 'u4' })).toBe(true);
  });

  test('returns true for all associations (permissive)', () => {
    const context = createMockContext();
    context.payload.comment = { author_association: 'NONE' };
    expect(isTrustedCommentAuthor(context, { login: 'u5' })).toBe(true);
  });
});

describe('AUTHORIZED_ASSOCIATIONS', () => {
  test('contains trusted author associations', () => {
    expect(AUTHORIZED_ASSOCIATIONS.has('OWNER')).toBe(true);
    expect(AUTHORIZED_ASSOCIATIONS.has('MEMBER')).toBe(true);
    expect(AUTHORIZED_ASSOCIATIONS.has('COLLABORATOR')).toBe(true);
    expect(AUTHORIZED_ASSOCIATIONS.has('CONTRIBUTOR')).toBe(true);
    expect(AUTHORIZED_ASSOCIATIONS.has('NONE')).toBe(true);
    expect(AUTHORIZED_ASSOCIATIONS.has('FIRST_TIMER')).toBe(true);
    expect(AUTHORIZED_ASSOCIATIONS.has('FIRST_TIME_CONTRIBUTOR')).toBe(true);
    expect(AUTHORIZED_ASSOCIATIONS.has('MANNEQUIN')).toBe(true);
  });
});
