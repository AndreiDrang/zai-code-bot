/**
 * Integration test fixtures for PR and command events
 */

const COMMENT_MARKER = '<!-- zai-code-review -->';

function createPrOpenedEvent(prNumber = 42, owner = 'test-owner', repo = 'test-repo') {
  return {
    action: 'opened',
    number: prNumber,
    pull_request: {
      url: `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      id: 1,
      number: prNumber,
      title: 'feat: Add new feature',
      state: 'open',
      locked: false,
      user: {
        login: 'test-user',
        id: 1,
        type: 'User'
      },
      body: 'This PR adds a new feature to the codebase.',
      created_at: '2024-01-15T10:00:00Z',
      updated_at: '2024-01-15T10:00:00Z',
      head: {
        ref: 'feature-branch',
        sha: 'abc123def456'
      },
      base: {
        ref: 'main',
        sha: 'xyz789abc123'
      },
      mergeable: true,
      mergeable_state: 'clean'
    },
    repository: {
      id: 100,
      name: repo,
      full_name: `${owner}/${repo}`,
      private: false,
      owner: {
        login: owner,
        id: 1,
        type: 'User'
      }
    },
    sender: {
      login: 'test-user',
      id: 1,
      type: 'User'
    }
  };
}

function createPrSynchronizeEvent(prNumber = 42, owner = 'test-owner', repo = 'test-repo') {
  return {
    action: 'synchronize',
    number: prNumber,
    pull_request: {
      url: `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      id: 1,
      number: prNumber,
      title: 'feat: Add new feature',
      state: 'open',
      locked: false,
      user: {
        login: 'test-user',
        id: 1,
        type: 'User'
      },
      body: 'This PR adds a new feature to the codebase.',
      created_at: '2024-01-15T10:00:00Z',
      updated_at: '2024-01-16T10:00:00Z',
      head: {
        ref: 'feature-branch',
        sha: 'new-sha-abc123'
      },
      base: {
        ref: 'main',
        sha: 'xyz789abc123'
      },
      mergeable: true,
      mergeable_state: 'clean'
    },
    repository: {
      id: 100,
      name: repo,
      full_name: `${owner}/${repo}`,
      private: false,
      owner: {
        login: owner,
        id: 1,
        type: 'User'
      }
    },
    sender: {
      login: 'test-user',
      id: 1,
      type: 'User'
    }
  };
}

function createIssueCommentEvent(
  action = 'created',
  commentBody = '/zai ask what is this?',
  prNumber = 42,
  owner = 'test-owner',
  repo = 'test-repo',
  commenter = 'test-user'
) {
  return {
    action,
    issue: {
      url: `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}`,
      id: 1,
      number: prNumber,
      title: 'feat: Add new feature',
      state: 'open',
      user: {
        login: 'test-user',
        id: 1,
        type: 'User'
      },
      body: 'This PR adds a new feature to the codebase.',
      created_at: '2024-01-15T10:00:00Z',
      updated_at: '2024-01-15T10:00:00Z',
      pull_request: {
        url: `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        html_url: `https://github.com/${owner}/${repo}/pull/${prNumber}`
      }
    },
    comment: {
      id: 1,
      body: commentBody,
      user: {
        login: commenter,
        id: 2,
        type: 'User'
      },
      created_at: '2024-01-15T10:00:00Z',
      updated_at: '2024-01-15T10:00:00Z'
    },
    repository: {
      id: 100,
      name: repo,
      full_name: `${owner}/${repo}`,
      private: false,
      owner: {
        login: owner,
        id: 1,
        type: 'User'
      }
    },
    sender: {
      login: commenter,
      id: 2,
      type: 'User'
    }
  };
}

function createMockFiles(files = []) {
  return files.map((filename, index) => ({
    sha: `sha-${index}`,
    filename,
    status: 'modified',
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: `@@ -1,5 +1,10 @@\n+// Added line\n function example() {\n-  return 'old';\n+  return 'new';\n }\n`
  }));
}

function createMockComments(existingBody = null) {
  if (existingBody === null) {
    return [];
  }
  return [{
    id: 100,
    body: existingBody,
    user: { login: 'test-user' },
    created_at: '2024-01-15T10:00:00Z'
  }];
}

module.exports = {
  COMMENT_MARKER,
  createPrOpenedEvent,
  createPrSynchronizeEvent,
  createIssueCommentEvent,
  createMockFiles,
  createMockComments
};
