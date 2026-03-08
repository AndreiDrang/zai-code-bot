/**
 * Tests for src/lib/handlers/ask.js
 */
const { describe, test } = require('node:test');
const assert = require('node:assert');
const askModule = require('../../src/lib/handlers/ask');

describe('ask.js - resolveRepoRef', () => {
  test('extracts owner and repo from githubContext.repo', () => {
    const githubContext = { repo: { owner: 'test-owner', repo: 'test-repo' } };
    const result = askModule.resolveRepoRef(githubContext);
    assert.deepStrictEqual(result, { owner: 'test-owner', repo: 'test-repo' });
  });

  test('extracts owner and repo from payload.repository', () => {
    const githubContext = {
      payload: { repository: { owner: { login: 'payload-owner' }, name: 'payload-repo' } }
    };
    const result = askModule.resolveRepoRef(githubContext);
    assert.deepStrictEqual(result, { owner: 'payload-owner', repo: 'payload-repo' });
  });

  test('returns null for missing owner/repo', () => {
    const result = askModule.resolveRepoRef({});
    assert.deepStrictEqual(result, { owner: null, repo: null });
  });
});

describe('ask.js - resolveIssueNumber', () => {
  test('extracts issue number from pull_request', () => {
    const githubContext = { payload: { pull_request: { number: 42 } } };
    assert.strictEqual(askModule.resolveIssueNumber(githubContext), 42);
  });

  test('extracts issue number from issue', () => {
    const githubContext = { payload: { issue: { number: 99 } } };
    assert.strictEqual(askModule.resolveIssueNumber(githubContext), 99);
  });

  test('returns null when no issue number', () => {
    assert.strictEqual(askModule.resolveIssueNumber({ payload: {} }), null);
  });
});

describe('ask.js - validateArgs', () => {
  test('returns valid for non-empty args', () => {
    const result = askModule.validateArgs(['what', 'is', 'this']);
    assert.deepStrictEqual(result, { valid: true });
  });

  test('returns error for empty args', () => {
    const result = askModule.validateArgs([]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Please provide a question'));
  });

  test('returns error for null args', () => {
    const result = askModule.validateArgs(null);
    assert.strictEqual(result.valid, false);
  });

  test('returns error for whitespace-only args', () => {
    const result = askModule.validateArgs(['   ']);
    assert.strictEqual(result.valid, false);
  });
});

describe('ask.js - buildPrompt', () => {
  test('builds prompt with string context', () => {
    const result = askModule.buildPrompt('What is this?', 'Some context here');
    assert.ok(result.includes('What is this?'));
    assert.ok(result.includes('Some context here'));
  });

  test('builds prompt with object context', () => {
    const contextContent = {
      prContext: 'PR title',
      fileContext: 'File diff',
      conversationHistory: 'History'
    };
    const result = askModule.buildPrompt('Question?', contextContent);
    assert.ok(result.includes('Question?'));
    assert.ok(result.includes('PR title'));
    assert.ok(result.includes('File diff'));
    assert.ok(result.includes('History'));
    assert.ok(result.includes('<pr_context>'));
    assert.ok(result.includes('<file_context>'));
    assert.ok(result.includes('<user_query>'));
  });

  test('handles missing context fields', () => {
    const result = askModule.buildPrompt('Test?', {});
    assert.ok(result.includes('unavailable'));
  });
});

describe('ask.js - formatResponse', () => {
  test('formats response with question', () => {
    const result = askModule.formatResponse('This is the answer.', 'What?');
    assert.ok(result.includes('Answer to: "What?"'));
    assert.ok(result.includes('This is the answer.'));
    assert.ok(result.includes('Z.ai'));
  });
});

describe('ask.js - handleAskCommand', () => {
  const createMockContext = (overrides = {}) => ({
    octokit: {},
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      payload: {
        pull_request: { number: 1 },
        comment: { id: 100 }
      },
      ...overrides.context
    },
    commenter: { login: 'user' },
    args: ['what', 'is', 'this'],
    config: { apiKey: 'key', model: 'model', timeout: 30000, maxRetries: 3 },
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    ...overrides
  });

  test('returns error for empty args', async () => {
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: true }),
      setReaction: async () => {},
      upsertComment: async () => ({ action: 'created' }),
      createApiClient: () => ({ call: async () => ({ success: true, data: 'answer' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: () => ({}),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext({ args: [] });
    const result = await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Please provide a question'));
  });

  test('returns error when not authorized', async () => {
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: false, reason: 'Not a collaborator' }),
      setReaction: async () => {},
      upsertComment: async () => ({ action: 'created' }),
      createApiClient: () => ({ call: async () => ({ success: true, data: 'answer' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: () => ({}),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext();
    const result = await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'Not a collaborator');
  });

  test('silent block when fork PR without reason', async () => {
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: false, reason: null }),
      setReaction: async () => {},
      upsertComment: async () => ({ action: 'created' }),
      createApiClient: () => ({ call: async () => ({ success: true, data: 'answer' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: () => ({}),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext();
    const result = await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, null);
  });

  test('returns error when owner/repo missing', async () => {
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: true }),
      setReaction: async () => {},
      upsertComment: async () => ({ action: 'created' }),
      createApiClient: () => ({ call: async () => ({ success: true, data: 'answer' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: () => ({}),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext({
      context: { payload: { pull_request: { number: 1 }, comment: { id: 100 } } }
    });
    const result = await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Unable to resolve repository'));
  });

  test('returns error when issue number missing', async () => {
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: true }),
      setReaction: async () => {},
      upsertComment: async () => ({ action: 'created' }),
      createApiClient: () => ({ call: async () => ({ success: true, data: 'answer' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: () => ({}),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext({
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { comment: { id: 100 } }
      }
    });
    const result = await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Unable to resolve pull request number'));
  });

  test('sets thinking reaction on start', async () => {
    const reactionsSet = [];
    
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: true }),
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        reactionsSet.push(reaction);
      },
      upsertComment: async () => ({ action: 'created' }),
      createApiClient: () => ({ call: async () => ({ success: true, data: 'answer' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: () => ({}),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext();
    await askModule.handleAskCommand(params, mockDeps);
    
    assert.ok(reactionsSet.includes('eyes'), 'Should include thinking reaction');
    assert.ok(reactionsSet.includes('rocket'), 'Should include rocket reaction on success');
  });

  test('calls API and posts response on success', async () => {
    let commentPosted = false;
    let rocketSet = false;
    
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: true }),
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        if (reaction === 'rocket') rocketSet = true;
      },
      upsertComment: async () => { commentPosted = true; return { action: 'created' }; },
      createApiClient: () => ({ call: async () => ({ success: true, data: 'This is the answer.' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: 'PR info', fileContext: 'File info', conversationHistory: 'History' }),
      mergeState: () => ({ turnCount: 1 }),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext();
    const result = await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(result.success, true);
    assert.ok(commentPosted);
    assert.ok(rocketSet);
  });

  test('handles API failure', async () => {
    let xReactionSet = false;
    
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: true }),
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        if (reaction === '-1') xReactionSet = true;
      },
      upsertComment: async () => ({ action: 'created' }),
      createApiClient: () => ({ 
        call: async () => ({ success: false, error: { category: 'network', message: 'Timeout' } }) 
      }),
      getUserMessage: () => 'Network error occurred',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: () => ({}),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext();
    const result = await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Network error'));
    assert.ok(xReactionSet);
  });

  test('handles comment post failure', async () => {
    let xReactionSet = false;
    
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: true }),
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        if (reaction === '-1') xReactionSet = true;
      },
      upsertComment: async () => ({ action: 'failed' }),
      createApiClient: () => ({ call: async () => ({ success: true, data: 'answer' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: () => ({}),
      createCommentWithState: (body) => body,
    };

    const params = createMockContext();
    const result = await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'Failed to post response');
    assert.ok(xReactionSet);
  });

  test('merges continuity state', async () => {
    let mergedState = null;
    
    const mockDeps = {
      checkForkAuthorization: async () => ({ authorized: true }),
      setReaction: async () => {},
      upsertComment: async () => ({ action: 'created' }),
      createApiClient: () => ({ call: async () => ({ success: true, data: 'answer' }) }),
      getUserMessage: () => 'Error',
      buildContext: async () => ({ prContext: '', fileContext: '', conversationHistory: '' }),
      mergeState: (existing, updates) => { mergedState = updates; return updates; },
      createCommentWithState: (body, state) => { mergedState = state; return body; },
    };

    const params = createMockContext({ continuityState: { turnCount: 5 } });
    await askModule.handleAskCommand(params, mockDeps);
    
    assert.strictEqual(mergedState.lastCommand, 'ask');
    assert.strictEqual(mergedState.lastArgs, 'what is this');
    assert.strictEqual(mergedState.turnCount, 6);
  });
});
