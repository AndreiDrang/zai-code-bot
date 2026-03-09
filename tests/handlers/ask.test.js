/**
 * Tests for src/lib/handlers/ask.js
 */
import { test, describe, expect } from 'vitest';
const askModule = require('../../src/lib/handlers/ask');

describe('ask.js - resolveRepoRef', () => {
  test('extracts owner and repo from githubContext.repo', () => {
    const githubContext = { repo: { owner: 'test-owner', repo: 'test-repo' } };
    const result = askModule.resolveRepoRef(githubContext);
    expect(result).toEqual({ owner: 'test-owner', repo: 'test-repo' });
  });

  test('extracts owner and repo from payload.repository', () => {
    const githubContext = {
      payload: { repository: { owner: { login: 'payload-owner' }, name: 'payload-repo' } }
    };
    const result = askModule.resolveRepoRef(githubContext);
    expect(result).toEqual({ owner: 'payload-owner', repo: 'payload-repo' });
  });

  test('returns null for missing owner/repo', () => {
    const result = askModule.resolveRepoRef({});
    expect(result).toEqual({ owner: null, repo: null });
  });
});

describe('ask.js - resolveIssueNumber', () => {
  test('extracts issue number from pull_request', () => {
    const githubContext = { payload: { pull_request: { number: 42 } } };
    expect(askModule.resolveIssueNumber(githubContext)).toBe(42);
  });

  test('extracts issue number from issue', () => {
    const githubContext = { payload: { issue: { number: 99 } } };
    expect(askModule.resolveIssueNumber(githubContext)).toBe(99);
  });

  test('returns null when no issue number', () => {
    expect(askModule.resolveIssueNumber({ payload: {} })).toBe(null);
  });
});

describe('ask.js - validateArgs', () => {
  test('returns valid for non-empty args', () => {
    const result = askModule.validateArgs(['what', 'is', 'this']);
    expect(result).toEqual({ valid: true });
  });

  test('returns error for empty args', () => {
    const result = askModule.validateArgs([]);
    expect(result.valid).toBe(false);
    expect(result.error.includes('Please provide a question')).toBe(true);
  });

  test('returns error for null args', () => {
    const result = askModule.validateArgs(null);
    expect(result.valid).toBe(false);
  });

  test('returns error for whitespace-only args', () => {
    const result = askModule.validateArgs(['   ']);
    expect(result.valid).toBe(false);
  });
});

describe('ask.js - buildPrompt', () => {
  test('builds prompt with string context', () => {
    const result = askModule.buildPrompt('What is this?', 'Some context here');
    expect(result.includes('What is this?')).toBe(true);
    expect(result.includes('Some context here')).toBe(true);
  });

  test('builds prompt with object context', () => {
    const contextContent = {
      prContext: 'PR title',
      fileContext: 'File diff',
      conversationHistory: 'History'
    };
    const result = askModule.buildPrompt('Question?', contextContent);
    expect(result.includes('Question?')).toBe(true);
    expect(result.includes('PR title')).toBe(true);
    expect(result.includes('File diff')).toBe(true);
    expect(result.includes('History')).toBe(true);
    expect(result.includes('<pr_context>')).toBe(true);
    expect(result.includes('<file_context>')).toBe(true);
    expect(result.includes('<user_query>')).toBe(true);
  });

  test('handles missing context fields', () => {
    const result = askModule.buildPrompt('Test?', {});
    expect(result.includes('unavailable')).toBe(true);
  });
});

describe('ask.js - formatResponse', () => {
  test('formats response with question', () => {
    const result = askModule.formatResponse('This is the answer.', 'What?');
    expect(result.includes('Answer to: "What?"')).toBe(true);
    expect(result.includes('This is the answer.')).toBe(true);
    expect(result.includes('Z.ai')).toBe(true);
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
    
    expect(result.success).toBe(false);
    expect(result.error.includes('Please provide a question')).toBe(true);
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
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('Not a collaborator');
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
    
    expect(result.success).toBe(false);
    expect(result.error).toBe(null);
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
    
    expect(result.success).toBe(false);
    expect(result.error.includes('Unable to resolve repository')).toBe(true);
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
    
    expect(result.success).toBe(false);
    expect(result.error.includes('Unable to resolve pull request number')).toBe(true);
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
    
    expect(reactionsSet.includes('eyes')).toBeTruthy('Should include thinking reaction');
    expect(reactionsSet.includes('rocket')).toBeTruthy('Should include rocket reaction on success');
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
    
    expect(result.success).toBe(true);
    expect(commentPosted).toBeTruthy();
    expect(rocketSet).toBeTruthy();
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
    
    expect(result.success).toBe(false);
    expect(result.error.includes('Network error')).toBe(true);
    expect(xReactionSet).toBeTruthy();
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
    
    expect(result.success).toBe(false);
    expect(result.error).toBe('Failed to post response');
    expect(xReactionSet).toBeTruthy();
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
    
    expect(mergedState.lastCommand).toBe('ask');
    expect(mergedState.lastArgs).toBe('what is this');
    expect(mergedState.turnCount).toBe(6);
  });
});
