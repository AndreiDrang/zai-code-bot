const { test, describe } = require('node:test');
const assert = require('node:assert');
const { 
  buildImpactPrompt, 
  extractSuggestedLabels, 
  formatChangedFiles,
  handleImpactCommand,
  applySuggestedLabels
} = require('../../src/lib/handlers/impact');

const { upsertComment, setReaction, REACTIONS } = require('../../src/lib/comments');

describe('impact.js - formatChangedFiles', () => {
  test('returns "No files changed" when array is empty', () => {
    const result = formatChangedFiles([]);
    assert.strictEqual(result, 'No files changed');
  });

  test('returns "No files changed" when null', () => {
    const result = formatChangedFiles(null);
    assert.strictEqual(result, 'No files changed');
  });

  test('formats a single modified file with patch', () => {
    const files = [{
      filename: 'src/index.js',
      status: 'modified',
      patch: '@@ -1,3 +1,4 @@\n+new line\n old line'
    }];
    
    const result = formatChangedFiles(files);
    
    assert.ok(result.includes('`src/index.js`'));
    assert.ok(result.includes('(modified)'));
    assert.ok(result.includes('```diff'));
    assert.ok(result.includes('+new line'));
  });

  test('formats file without patch', () => {
    const files = [{
      filename: 'README.md',
      status: 'added',
      patch: null
    }];
    
    const result = formatChangedFiles(files);
    
    assert.ok(result.includes('`README.md`'));
    assert.ok(result.includes('(added)'));
    assert.ok(!result.includes('```diff'));
  });

  test('truncates long patches', () => {
    const longPatch = Array(60).fill('line content').join('\n');
    const files = [{
      filename: 'large.js',
      status: 'modified',
      patch: longPatch
    }];
    
    const result = formatChangedFiles(files);
    
    assert.ok(result.includes('[truncated'));
  });

  test('handles multiple files', () => {
    const files = [
      { filename: 'a.js', status: 'added', patch: null },
      { filename: 'b.js', status: 'removed', patch: null }
    ];
    
    const result = formatChangedFiles(files);
    
    assert.ok(result.includes('`a.js`'));
    assert.ok(result.includes('`b.js`'));
  });
});

describe('impact.js - buildImpactPrompt', () => {
  test('builds prompt with PR title and description', () => {
    const pr = { title: 'Add feature X', body: 'This PR adds feature X' };
    const files = [{ filename: 'src/x.js', status: 'added', patch: null }];
    
    const result = buildImpactPrompt(pr, files, 10000);
    
    assert.ok(result.prompt.includes('Add feature X'));
    assert.ok(result.prompt.includes('This PR adds feature X'));
    assert.ok(result.prompt.includes('src/x.js'));
    assert.strictEqual(result.truncated, false);
  });

  test('handles missing PR title', () => {
    const pr = { title: null, body: 'Body only' };
    const files = [];
    
    const result = buildImpactPrompt(pr, files, 10000);
    
    assert.ok(result.prompt.includes('No title provided'));
    assert.ok(result.prompt.includes('Body only'));
  });

  test('handles missing PR body', () => {
    const pr = { title: 'Title only', body: null };
    const files = [];
    
    const result = buildImpactPrompt(pr, files, 10000);
    
    assert.ok(result.prompt.includes('Title only'));
    assert.ok(result.prompt.includes('No description provided'));
  });

  test('respects maxChars and truncates', () => {
    const pr = { 
      title: 'Title', 
      body: 'x'.repeat(500) 
    };
    const files = [{ filename: 'test.js', status: 'modified', patch: 'y'.repeat(500) }];
    
    const result = buildImpactPrompt(pr, files, 100);
    
    assert.strictEqual(result.truncated, true);
  });
});

describe('impact.js - extractSuggestedLabels', () => {
  test('extracts backticked labels from response', () => {
    const response = `**Risk Level:** 🟡 Medium

**Impact Summary:**
This PR modifies authentication logic.

**Critical Areas Touched:**
* \`auth/middleware.js\`: Modified token validation

**Suggested Labels:**
\`risk: medium\`, \`area: auth\`, \`type: security\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: medium', 'area: auth', 'type: security']);
  });

  test('returns empty array for null response', () => {
    const labels = extractSuggestedLabels(null);
    assert.deepStrictEqual(labels, []);
  });

  test('returns empty array for empty string', () => {
    const labels = extractSuggestedLabels('');
    assert.deepStrictEqual(labels, []);
  });

  test('returns empty array when no labels section found', () => {
    const response = `**Risk Level:** 🟢 Low

**Impact Summary:**
Documentation changes only.`;

    const labels = extractSuggestedLabels(response);
    assert.deepStrictEqual(labels, []);
  });

  test('handles labels with spaces', () => {
    const response = `**Suggested Labels:**
\`risk: high\`, \`area: database\`, \`needs review\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: high', 'area: database', 'needs review']);
  });

  test('deduplicates labels', () => {
    const response = `**Suggested Labels:**
\`risk: medium\`, \`area: auth\`, \`risk: medium\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: medium', 'area: auth']);
  });

  test('limits to 5 labels', () => {
    const response = `**Suggested Labels:**
\`label1\`, \`label2\`, \`label3\`, \`label4\`, \`label5\`, \`label6\``;

    const labels = extractSuggestedLabels(response);
    
    assert.strictEqual(labels.length, 5);
  });

  test('filters out empty and whitespace-only labels', () => {
    const response = `**Suggested Labels:**
\`valid\`, \`   \`, \`also-valid\``;

    const labels = extractSuggestedLabels(response);
    
    // Whitespace-only label should be filtered out after trim
    assert.deepStrictEqual(labels, ['valid', 'also-valid']);
  });
  test('filters out excessively long labels', () => {
    const longLabel = 'x'.repeat(60);
    const response = `**Suggested Labels:**
\`${longLabel}\`, \`valid\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['valid']);
  });

  test('fallback to comma-separated if no backticks', () => {
    const response = `**Suggested Labels:**
risk: medium, area: auth, type: bugfix`;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: medium', 'area: auth', 'type: bugfix']);
  });

  test('case-insensitive labels section detection', () => {
    const response = `**suggested labels:**
\`risk: low\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: low']);
  });
});

describe('impact.js - applySuggestedLabels', () => {
  test('returns true when labels is empty', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          addLabels: async () => {}
        }
      }
    };
    const mockLogger = { info: () => {}, warn: () => {} };
    
    const result = await applySuggestedLabels(mockOctokit, 'owner', 'repo', 1, [], mockLogger);
    assert.strictEqual(result, true);
  });

  test('returns true when labels is null', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          addLabels: async () => {}
        }
      }
    };
    const mockLogger = { info: () => {}, warn: () => {} };
    
    const result = await applySuggestedLabels(mockOctokit, 'owner', 'repo', 1, null, mockLogger);
    assert.strictEqual(result, true);
  });

  test('calls octokit.issues.addLabels with correct params', async () => {
    let addLabelsCalled = false;
    let addLabelsParams = null;
    
    const mockOctokit = {
      rest: {
        issues: {
          addLabels: async (params) => {
            addLabelsCalled = true;
            addLabelsParams = params;
          }
        }
      }
    };
    const mockLogger = { info: () => {}, warn: () => {} };
    
    const labels = ['risk: medium', 'area: auth'];
    await applySuggestedLabels(mockOctokit, 'test-owner', 'test-repo', 42, labels, mockLogger);
    
    assert.strictEqual(addLabelsCalled, true);
    assert.strictEqual(addLabelsParams.owner, 'test-owner');
    assert.strictEqual(addLabelsParams.repo, 'test-repo');
    assert.strictEqual(addLabelsParams.issue_number, 42);
    assert.deepStrictEqual(addLabelsParams.labels, labels);
  });

  test('returns false and logs warning on API error', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          addLabels: async () => {
            throw new Error('API rate limit exceeded');
          }
        }
      }
    };
    let warnCalled = false;
    let warnArgs = null;
    const mockLogger = { 
      info: () => {}, 
      warn: (args, msg) => {
        warnCalled = true;
        warnArgs = args;
      }
    };
    
    const labels = ['risk: medium'];
    const result = await applySuggestedLabels(mockOctokit, 'owner', 'repo', 1, labels, mockLogger);
    
    assert.strictEqual(result, false);
    assert.strictEqual(warnCalled, true);
    assert.strictEqual(warnArgs.labels, labels);
  });
});

describe('impact.js - handleImpactCommand', () => {
  test('returns success when all operations succeed', async () => {
    let thinkingSet = false;
    let rocketSet = false;
    let commentPosted = false;
    let apiCalled = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        if (reaction === 'eyes') thinkingSet = true;
        if (reaction === 'rocket') rocketSet = true;
      },
      applySuggestedLabels: async () => true,
    };
    
    const mockOctokit = {
      rest: {
        pulls: { get: async () => ({ data: { title: 'Test PR', body: 'Test body' } }) },
        issues: { createComment: async () => {}, addLabels: async () => {} },
        reactions: { createForIssueComment: async () => {} }
      }
    };
    
    const mockApiClient = {
      call: async () => { apiCalled = true; return { success: true, data: 'Analysis result' }; }
    };
    
    const context = {
      octokit: mockOctokit,
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: mockApiClient,
      apiKey: 'test-key',
      model: 'test-model',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      changedFiles: []
    };
    
    const result = await handleImpactCommand(context, [], mockDeps);
    
    assert.strictEqual(result.success, true);
    assert.ok(thinkingSet);
    assert.ok(rocketSet);
    assert.ok(commentPosted);
    assert.ok(apiCalled);
  });

  test('fetches PR metadata and builds prompt', async () => {
    let apiCallParams = null;
    
    const mockDeps = {
      upsertComment: async () => ({ data: { id: 123 } }),
      setReaction: async () => {},
      applySuggestedLabels: async () => true,
    };
    
    const mockOctokit = {
      rest: {
        pulls: { get: async () => ({ data: { title: 'Test PR', body: 'Test description' } }) },
        issues: { createComment: async () => {}, addLabels: async () => {} },
        reactions: { createForIssueComment: async () => {} }
      }
    };
    
    const mockApiClient = {
      call: async (params) => {
        apiCallParams = params;
        return { success: true, data: 'Impact analysis' };
      }
    };
    
    const context = {
      octokit: mockOctokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 1,
      commentId: 1,
      apiClient: mockApiClient,
      apiKey: 'key',
      model: 'model',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      changedFiles: []
    };
    
    await handleImpactCommand(context, [], mockDeps);
    
    assert.ok(apiCallParams.prompt.includes('Test PR'));
    assert.ok(apiCallParams.prompt.includes('Test description'));
  });

  test('returns error when PR fetch fails', async () => {
    let commentPosted = false;
    let xReactionSet = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        if (reaction === '-1') xReactionSet = true;
      },
      applySuggestedLabels: async () => true,
    };
    
    const mockOctokit = {
      rest: {
        pulls: { get: async () => { throw new Error('Not found'); } },
        issues: { createComment: async () => {} },
        reactions: { createForIssueComment: async () => {} }
      }
    };
    
    const mockApiClient = { call: async () => ({ success: true }) };
    
    const context = {
      octokit: mockOctokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 1,
      commentId: 1,
      apiClient: mockApiClient,
      apiKey: 'key',
      model: 'model',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      changedFiles: []
    };
    
    const result = await handleImpactCommand(context, [], mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Failed to fetch PR metadata'));
    assert.ok(commentPosted);
    assert.ok(xReactionSet);
  });

  test('returns error when API call fails', async () => {
    let commentPosted = false;
    let xReactionSet = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        if (reaction === '-1') xReactionSet = true;
      },
      applySuggestedLabels: async () => true,
    };
    
    const mockOctokit = {
      rest: {
        pulls: { get: async () => ({ data: { title: 'PR', body: 'desc' } }) },
        issues: { createComment: async () => {}, addLabels: async () => {} },
        reactions: { createForIssueComment: async () => {} }
      }
    };
    
    const mockApiClient = {
      call: async () => ({ success: false, error: 'API rate limit' })
    };
    
    const context = {
      octokit: mockOctokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 1,
      commentId: 1,
      apiClient: mockApiClient,
      apiKey: 'key',
      model: 'model',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      changedFiles: []
    };
    
    const result = await handleImpactCommand(context, [], mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('API rate limit'));
    assert.ok(commentPosted);
    assert.ok(xReactionSet);
  });

  test('extracts and applies suggested labels', async () => {
    let labelsApplied = null;
    
    const mockDeps = {
      upsertComment: async () => ({ data: { id: 123 } }),
      setReaction: async () => {},
      applySuggestedLabels: async (octokit, owner, repo, issueNumber, labels, logger) => {
        labelsApplied = labels;
        return true;
      },
    };
    
    const mockOctokit = {
      rest: {
        pulls: { get: async () => ({ data: { title: 'PR', body: 'desc' } }) },
        issues: { createComment: async () => {}, addLabels: async () => {} },
        reactions: { createForIssueComment: async () => {} }
      }
    };
    
    const mockApiClient = {
      call: async () => ({ 
        success: true, 
        data: '**Risk Level:** 🟠 High\n\n**Suggested Labels:**\n`risk: high`, `area: api`' 
      })
    };
    
    const context = {
      octokit: mockOctokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 1,
      commentId: 1,
      apiClient: mockApiClient,
      apiKey: 'key',
      model: 'model',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      changedFiles: []
    };
    
    await handleImpactCommand(context, [], mockDeps);
    
    assert.deepStrictEqual(labelsApplied, ['risk: high', 'area: api']);
  });

  test('handles exception and posts error comment', async () => {
    let errorCommentPosted = false;
    let xReactionSet = false;
    
    const mockDeps = {
      upsertComment: async () => { errorCommentPosted = true; return { data: { id: 123 } }; },
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        if (reaction === '-1') xReactionSet = true;
      },
      applySuggestedLabels: async () => true,
    };
    
    const mockOctokit = {
      rest: {
        pulls: { get: async () => { throw new Error('Network error'); } },
        issues: { createComment: async () => {} },
        reactions: { createForIssueComment: async () => {} }
      }
    };
    
    const context = {
      octokit: mockOctokit,
      owner: 'owner',
      repo: 'repo',
      issueNumber: 1,
      commentId: 1,
      apiClient: null,
      apiKey: 'key',
      model: 'model',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      changedFiles: []
    };
    
    const result = await handleImpactCommand(context, [], mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error !== undefined);
    assert.ok(errorCommentPosted);
    assert.ok(xReactionSet);
  });
});
