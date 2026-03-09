import { test, describe, expect } from 'vitest';
const { 
  buildPrompt, 
  GUIDANCE_MESSAGES, 
  COMMENT_MARKER, 
  GUIDANCE_MARKER, 
  PROGRESS_MARKER, 
  AUTH_MARKER,
  getChangedFiles,
  enforceCommandAuthorization,
  handlePullRequestEvent,
  dispatchCommand
} = require('../src/index');

const commentsModule = require('../src/lib/comments');

const REACTIONS = {
  EYES: 'eyes',
  THINKING: 'eyes',
  ROCKET: 'rocket',
  X: '-1',
};

describe('index.js - buildPrompt', () => {
  test('formats files with patches into XML structure', () => {
    const files = [
      { filename: 'src/index.js', patch: '+new line\n-old line' },
      { filename: 'src/lib/test.js', patch: '+another change' }
    ];
    
    const result = buildPrompt(files);
    
    expect(result.includes('<file name="src/index.js">')).toBe(true);
    expect(result.includes('<diff>')).toBe(true);
    expect(result.includes('+new line\n-old line')).toBe(true);
    expect(result.includes('</diff>')).toBe(true);
    expect(result.includes('</file>')).toBe(true);
    expect(result.includes('<pull_request_changes>')).toBe(true);
    expect(result.includes('</pull_request_changes>')).toBe(true);
  });

  test('filters out files without patches', () => {
    const files = [
      { filename: 'src/has-patch.js', patch: '+change' },
      { filename: 'src/no-patch.js', patch: null },
      { filename: 'src/also-no-patch.js' }
    ];
    
    const result = buildPrompt(files);
    
    expect(result.includes('src/has-patch.js')).toBe(true);
    expect(result.includes('src/no-patch.js')).toBeFalsy();
    expect(result.includes('src/also-no-patch.js')).toBeFalsy();
  });

  test('handles empty files array', () => {
    const result = buildPrompt([]);
    expect(result.includes('<pull_request_changes>')).toBe(true);
    expect(result.includes('</pull_request_changes>')).toBe(true);
  });

  test('handles files with empty patches', () => {
    const files = [
      { filename: 'src/empty.js', patch: '' }
    ];
    
    const result = buildPrompt(files);
    expect(result.includes('src/empty.js')).toBeFalsy();
  });

  test('includes system instructions reference', () => {
    const files = [{ filename: 'test.js', patch: '+x' }];
    const result = buildPrompt(files);
    expect(result.includes('system instructions')).toBe(true);
  });
});

describe('index.js - GUIDANCE_MESSAGES', () => {
  test('unknown_command contains all commands', () => {
    const msg = GUIDANCE_MESSAGES.unknown_command;
    expect(msg.includes('/zai ask')).toBe(true);
    expect(msg.includes('/zai review')).toBe(true);
    expect(msg.includes('/zai explain')).toBe(true);
    expect(msg.includes('/zai describe')).toBe(true);
    expect(msg.includes('/zai impact')).toBe(true);
    expect(msg.includes('/zai help')).toBe(true);
    expect(msg.includes('@zai-bot')).toBe(true);
  });

  test('malformed_input contains examples', () => {
    const msg = GUIDANCE_MESSAGES.malformed_input;
    expect(msg.includes('/zai ask')).toBe(true);
    expect(msg.includes('/zai review')).toBe(true);
    expect(msg.includes('/zai explain')).toBe(true);
  });

  test('empty_input mentions help command', () => {
    const msg = GUIDANCE_MESSAGES.empty_input;
    expect(msg.includes('/zai help')).toBe(true);
  });

  test('all messages contain comment marker', () => {
    Object.values(GUIDANCE_MESSAGES).forEach(msg => {
      expect(msg.includes(COMMENT_MARKER)).toBeTruthy(`Message should contain COMMENT_MARKER`);
    });
  });
});

describe('index.js - Markers', () => {
  test('COMMENT_MARKER is defined', () => {
    expect(COMMENT_MARKER).toBe('<!-- zai-code-review -->');
  });

  test('GUIDANCE_MARKER is defined', () => {
    expect(GUIDANCE_MARKER).toBe('<!-- zai-guidance -->');
  });

  test('PROGRESS_MARKER is defined', () => {
    expect(PROGRESS_MARKER).toBe('<!-- zai-progress -->');
  });

  test('AUTH_MARKER is defined', () => {
    expect(AUTH_MARKER).toBe('<!-- zai-auth -->');
  });
});

describe('index.js - getChangedFiles', () => {
  test('fetches files from octokit', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: async () => ({
            data: [
              { filename: 'src/a.js', patch: '+a' },
              { filename: 'src/b.js', patch: '+b' }
            ]
          })
        }
      }
    };

    const files = await getChangedFiles(mockOctokit, 'owner', 'repo', 1);
    
    expect(files.length).toBe(2);
    expect(files[0].filename).toBe('src/a.js');
    expect(files[1].filename).toBe('src/b.js');
  });

  test('handles empty response', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] })
        }
      }
    };

    const files = await getChangedFiles(mockOctokit, 'owner', 'repo', 1);
    
    expect(files.length).toBe(0);
  });

  test('passes correct params to octokit', async () => {
    let capturedParams = null;
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: async (params) => {
            capturedParams = params;
            return { data: [] };
          }
        }
      }
    };

    await getChangedFiles(mockOctokit, 'myowner', 'myrepo', 42);
    
    expect(capturedParams.owner).toBe('myowner');
    expect(capturedParams.repo).toBe('myrepo');
    expect(capturedParams.pull_number).toBe(42);
    expect(capturedParams.per_page).toBe(100);
  });
});

describe('index.js - enforceCommandAuthorization', () => {
  test('returns authorized when auth check passes', async () => {
    const mockContext = { payload: { sender: { login: 'user' } } };
    const mockOctokit = {};
    
    const mockDeps = {
      core: { info: () => {}, warning: () => {} },
      getCommenter: () => ({ login: 'user' }),
      checkForkAuthorization: async () => ({ authorized: true }),
      getUnauthorizedMessage: () => 'Not authorized',
      upsertComment: async () => {},
      setReaction: async () => {},
    };

    const result = await enforceCommandAuthorization(
      mockContext, 
      mockOctokit, 
      'owner', 
      'repo', 
      { issueNumber: 1, pullNumber: 1, replyToId: 100 },
      mockDeps
    );
    
    expect(result.authorized).toBe(true);
    expect(result.commenter.login).toBe('user');
  });

  test('returns silent block for fork PRs', async () => {
    const mockContext = { payload: { sender: { login: 'fork-user' } } };
    const mockOctokit = {};
    let infoLogged = null;
    
    const mockDeps = {
      core: { 
        info: (msg) => { infoLogged = msg; },
        warning: () => {}
      },
      getCommenter: () => ({ login: 'fork-user' }),
      checkForkAuthorization: async () => ({ authorized: false, reason: null }),
      getUnauthorizedMessage: () => 'Not authorized',
      upsertComment: async () => {},
      setReaction: async () => {},
    };

    const result = await enforceCommandAuthorization(
      mockContext, 
      mockOctokit, 
      'owner', 
      'repo', 
      { issueNumber: 1, pullNumber: 1, replyToId: 100 },
      mockDeps
    );
    
    expect(result.authorized).toBe(false);
    expect(result.silent).toBe(true);
    expect(infoLogged.includes('Silently blocking')).toBe(true);
  });

  test('posts auth message and reaction when not authorized', async () => {
    const mockContext = { payload: { sender: { login: 'unauthorized-user' } } };
    const mockOctokit = {};
    let commentPosted = null;
    let reactionSet = null;
    
    const mockDeps = {
      core: { info: () => {}, warning: () => {} },
      getCommenter: () => ({ login: 'unauthorized-user' }),
      checkForkAuthorization: async () => ({ authorized: false, reason: 'Not a collaborator' }),
      getUnauthorizedMessage: () => 'You are not a collaborator',
      upsertComment: async (octokit, owner, repo, issueNumber, body, marker, options) => {
        commentPosted = { body, marker, options };
      },
      setReaction: async (octokit, owner, repo, commentId, reaction) => {
        reactionSet = reaction;
      },
    };

    const result = await enforceCommandAuthorization(
      mockContext, 
      mockOctokit, 
      'owner', 
      'repo', 
      { issueNumber: 1, pullNumber: 1, replyToId: 100 },
      mockDeps
    );
    
    expect(result.authorized).toBe(false);
    expect(result.silent).toBe(false);
    expect(commentPosted ).not.toBeNull();
    expect(commentPosted.marker).toBe(AUTH_MARKER);
    expect(reactionSet).toBe('-1');
  });

  test('handles missing replyToId', async () => {
    const mockContext = { payload: { sender: { login: 'user' } } };
    const mockOctokit = {};
    let reactionCalled = false;
    
    const mockDeps = {
      core: { info: () => {}, warning: () => {} },
      getCommenter: () => ({ login: 'user' }),
      checkForkAuthorization: async () => ({ authorized: false, reason: 'Not allowed' }),
      getUnauthorizedMessage: () => 'Not allowed',
      upsertComment: async () => {},
      setReaction: async () => { reactionCalled = true; },
    };

    await enforceCommandAuthorization(
      mockContext, 
      mockOctokit, 
      'owner', 
      'repo', 
      { issueNumber: 1, pullNumber: 1 },
      mockDeps
    );
    
    expect(reactionCalled).toBe(false);
  });

  test('handles reaction error gracefully', async () => {
    const mockContext = { payload: { sender: { login: 'user' } } };
    const mockOctokit = {};
    let warningLogged = null;
    
    const mockDeps = {
      core: { 
        info: () => {},
        warning: (msg) => { warningLogged = msg; }
      },
      getCommenter: () => ({ login: 'user' }),
      checkForkAuthorization: async () => ({ authorized: false, reason: 'Not allowed' }),
      getUnauthorizedMessage: () => 'Not allowed',
      upsertComment: async () => {},
      setReaction: async () => { throw new Error('Rate limited'); },
    };

    const result = await enforceCommandAuthorization(
      mockContext, 
      mockOctokit, 
      'owner', 
      'repo', 
      { issueNumber: 1, pullNumber: 1, replyToId: 100 },
      mockDeps
    );
    
    expect(result.authorized).toBe(false);
    expect(warningLogged.includes('Rate limited')).toBe(true);
  });

  test('uses default dependencies when not provided', async () => {
    const mockContext = { 
      payload: { 
        sender: { login: 'test-user' },
        repository: { owner: { login: 'owner' }, name: 'repo' }
      } 
    };
    const mockOctokit = {};
    
    const result = await enforceCommandAuthorization(
      mockContext,
      mockOctokit,
      'owner',
      'repo',
      { issueNumber: 1, pullNumber: 1 }
    );

    expect(result.hasOwnProperty('authorized')).toBe(true);
    expect(result.hasOwnProperty('commenter')).toBe(true);
  });
});

describe('index.js - handlePullRequestEvent', () => {
  const createMockCore = () => ({ 
    setFailed: () => {}, 
    info: () => {},
    warning: () => {},
    getInput: () => 'mock-token'
  });
  
  const createMockOctokit = (overrides = {}) => ({
    rest: {
      pulls: { listFiles: async () => ({ data: [] }) },
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => ({ data: { id: 123 } }),
        updateComment: async () => {},
        ...overrides.issues
      }
    }
  });

  test('returns error when no pull request number', async () => {
    const mockContext = { payload: { pull_request: {} } };
    const mockCore = createMockCore();
    const mockGithub = { getOctokit: () => createMockOctokit() };

    const result = await handlePullRequestEvent(
      mockContext,
      'api-key',
      'model',
      'owner',
      'repo',
      { core: mockCore, github: mockGithub }
    );

    expect(result.success).toBe(false);
    expect(result.error.includes('No pull request number')).toBe(true);
  });

  test('skips when no patchable changes', async () => {
    const mockContext = { payload: { pull_request: { number: 1 } } };
    const mockCore = createMockCore();
    const mockGithub = { getOctokit: () => createMockOctokit() };

    const result = await handlePullRequestEvent(
      mockContext,
      'api-key',
      'model',
      'owner',
      'repo',
      { 
        core: mockCore, 
        github: mockGithub,
        getChangedFiles: async () => [],
      }
    );

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });

  test('creates comment when no existing review', async () => {
    const mockContext = { payload: { pull_request: { number: 1 } } };
    let commentCreated = false;
    const mockCore = createMockCore();
    const mockOctokit = createMockOctokit({
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async () => { 
          commentCreated = true;
          return { data: { id: 123 } };
        },
        updateComment: async () => {}
      }
    });
    const mockGithub = { getOctokit: () => mockOctokit };

    const result = await handlePullRequestEvent(
      mockContext,
      'api-key',
      'model',
      'owner',
      'repo',
      { 
        core: mockCore, 
        github: mockGithub,
        getChangedFiles: async () => [{ filename: 'test.js', patch: '+x' }],
        buildPrompt: () => 'prompt',
        callZaiApi: async () => 'Great code!',
      }
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe('created');
    expect(result.commentId).toBe(123);
    expect(commentCreated).toBeTruthy();
  });

  test('updates existing comment when review exists', async () => {
    const mockContext = { payload: { pull_request: { number: 1 } } };
    let commentUpdated = false;
    const mockCore = createMockCore();
    const mockOctokit = createMockOctokit({
      issues: {
        listComments: async () => ({ 
          data: [{ id: 456, body: '<!-- zai-code-review --> old review' }] 
        }),
        createComment: async () => ({ data: { id: 123 } }),
        updateComment: async () => { commentUpdated = true; }
      }
    });
    const mockGithub = { getOctokit: () => mockOctokit };

    const result = await handlePullRequestEvent(
      mockContext,
      'api-key',
      'model',
      'owner',
      'repo',
      { 
        core: mockCore, 
        github: mockGithub,
        getChangedFiles: async () => [{ filename: 'test.js', patch: '+x' }],
        buildPrompt: () => 'prompt',
        callZaiApi: async () => 'Updated review!',
      }
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe('updated');
    expect(result.commentId).toBe(456);
    expect(commentUpdated).toBeTruthy();
  });

  test('uses custom comment marker', async () => {
    const mockContext = { payload: { pull_request: { number: 1 } } };
    let capturedBody = null;
    const mockCore = createMockCore();
    const mockOctokit = createMockOctokit({
      issues: {
        listComments: async () => ({ data: [] }),
        createComment: async (params) => { 
          capturedBody = params.body;
          return { data: { id: 123 } };
        },
        updateComment: async () => {}
      }
    });
    const mockGithub = { getOctokit: () => mockOctokit };
    const customMarker = '<!-- custom-marker -->';

    await handlePullRequestEvent(
      mockContext,
      'api-key',
      'model',
      'owner',
      'repo',
      { 
        core: mockCore, 
        github: mockGithub,
        getChangedFiles: async () => [{ filename: 'test.js', patch: '+x' }],
        buildPrompt: () => 'prompt',
        callZaiApi: async () => 'Review!',
        COMMENT_MARKER: customMarker,
      }
    );

    expect(capturedBody.includes(customMarker)).toBe(true);
  });
});

describe('index.js - dispatchCommand', () => {
  const createMockContext = (overrides = {}) => ({
    eventName: 'issue_comment',
    payload: {
      issue: { number: 1, title: 'Test PR', body: 'PR description' },
      pull_request: { number: 1, title: 'Test PR', body: 'PR description' },
      repository: { owner: { login: 'owner' }, name: 'repo' },
      comment: { id: 100, body: '/zai help' },
      sender: { login: 'testuser' },
      ...overrides.payload,
    },
    ...overrides,
  });

  const createParseResult = (command, args = []) => ({ command, args });

  const createMockDeps = (overrides = {}) => ({
    core: { info: () => {}, warning: () => {}, error: () => {}, getInput: () => 'mock-token' },
    github: { 
      getOctokit: () => ({ 
        rest: { 
          pulls: { listFiles: async () => ({ data: [] }) },
          issues: { 
            listComments: async () => ({ data: [] }),
            createComment: async () => ({ data: { id: 123 } }),
            updateComment: async () => ({ data: {} }),
            addComment: async () => ({ data: { id: 123 } })
          },
          reactions: {
            createForIssueComment: async () => ({ data: { content: 'rocket' } })
          }
        } 
      }) 
    },
    generateCorrelationId: () => 'test-correlation-id',
    createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    fetchChangedFiles: async () => [],
    createApiClient: () => ({}),
    reviewHandler: { handleReviewCommand: async () => ({ success: true }) },
    explainHandler: { handleExplainCommand: async () => ({ success: true }) },
    handleDescribeCommand: async () => ({ success: true }),
    handleAskCommand: async () => ({ success: true }),
    handleImpactCommand: async () => ({ success: true }),
    upsertComment: async () => {},
    setReaction: async () => {},
    mergeState: (state, updates) => ({ ...state, ...updates }),
    createCommentWithState: (msg, state) => msg,
    COMMENT_MARKER: '<!-- zai-code-review -->',
    REACTIONS: REACTIONS,
    ...overrides,
  });

  const originalUpsertComment = commentsModule.upsertComment;
  const originalSetReaction = commentsModule.setReaction;

  test('review command success path returns success', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('review', ['src/index.js']);
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line' }];
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      reviewHandler: {
        handleReviewCommand: async (ctx, args) => ({ success: true })
      },
    });

    const result = await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(result.success).toBe(true);
  });

  test('review command failure path returns error', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('review', []);
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line' }];
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      reviewHandler: {
        handleReviewCommand: async (ctx, args) => ({ success: false, error: 'Failed to review' })
      },
    });

    const result = await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(result.success).toBe(false);
    expect(result.error.includes('Failed to review')).toBe(true);
  });

  test('explain command with explicit args returns success', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('explain', ['10-20']);
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line', status: 'modified' }];
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      explainHandler: {
        handleExplainCommand: async (ctx, args) => ({ success: true })
      },
    });

    const result = await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(result.success).toBe(true);
  });

  test('explain command infers range from review comment anchor', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('explain', []); 
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line', status: 'modified' }];
    let explainArgsUsed = null;
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      explainHandler: {
        handleExplainCommand: async (ctx, args) => {
          explainArgsUsed = args;
          return { success: true };
        }
      },
    });

    await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100, commentLine: 15, commentStartLine: 10 },
      mockDeps
    );

    expect(explainArgsUsed).toEqual(['10-15']);
  });

  test('describe command success path returns success', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('describe', []);
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line' }];
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      handleDescribeCommand: async (ctx, args) => ({ success: true }),
    });

    const result = await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(result.success).toBe(true);
  });

  test('describe command failure path returns error', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('describe', []);
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line' }];
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      handleDescribeCommand: async (ctx, args) => ({ success: false, error: 'Failed to describe' }),
    });

    const result = await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(result.success).toBe(false);
    expect(result.error.includes('Failed to describe')).toBe(true);
  });

  test('ask command silent block when authorized false', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('ask', ['What is this?']);
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line' }];
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      handleAskCommand: async (ctx) => ({ success: false, error: null }), 
    });

    const result = await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(result.success).toBe(true);
    expect(result.silent).toBe(true);
  });

  test('ask command success path returns success', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('ask', ['What is this?']);
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line' }];
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      handleAskCommand: async (ctx) => ({ success: true }),
    });

    const result = await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(result.success).toBe(true);
  });

  test('impact command returns early without posting comment', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('impact', []);
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line' }];
    let commentPosted = false;
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      handleImpactCommand: async (ctx, args) => ({ success: true }),
    });

    await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(commentPosted).toBe(false);
  });

  test('changed-file fetch warning path when fetch fails', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('help', []);
    let warningLogged = null;
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => { throw new Error('Network error'); },
      createLogger: () => ({
        info: () => {},
        warn: (obj, msg) => { warningLogged = msg; },
        error: () => {},
      }),
    });

    await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100 },
      mockDeps
    );

    expect(warningLogged.includes('Failed to fetch changed files')).toBe(true);
  });

  test('explain command uses commentPath when available', async () => {
    const mockContext = createMockContext();
    const parseResult = createParseResult('explain', []); 
    const changedFiles = [{ filename: 'src/index.js', patch: '+new line', status: 'modified' }];
    let filenameUsed = null;
    
    const mockDeps = createMockDeps({
      fetchChangedFiles: async () => changedFiles,
      explainHandler: {
        handleExplainCommand: async (ctx, args) => {
          filenameUsed = ctx.filename;
          return { success: true };
        }
      },
    });

    await dispatchCommand(
      mockContext,
      parseResult,
      'api-key',
      'model',
      'owner',
      'repo',
      30000,
      { commentId: 100, commentPath: 'src/utils.js', commentLine: 5, commentStartLine: 3 },
      mockDeps
    );

    expect(filenameUsed).toBe('src/utils.js');
  });
});
