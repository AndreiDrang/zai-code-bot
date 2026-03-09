import { test, describe, expect, beforeEach, afterEach } from 'vitest';
const COMMENT_MARKER = '<!-- zai-code-review -->';

const {
  createIssueCommentEvent,
  createMockFiles,
} = require('./fixtures/events.js');

const events = require('../../src/lib/events.js');
const commands = require('../../src/lib/commands.js');
const auth = require('../../src/lib/auth.js');
const handlers = require('../../src/lib/handlers/index.js');

const api = require('../../src/lib/api.js');
const comments = require('../../src/lib/comments.js');

require('@actions/github');
require('@actions/core');

// Local lightweight stub helper (replaces sinon)
function createStub() {
  const stub = {
    called: false,
    callCount: 0
  };
  
  // The wrapped function that tracks calls
  const fn = function(...args) {
    stub.called = true;
    stub.callCount++;
    return fn._returns;
  };
  
  // Attach properties to the function so .called works when accessed on it
  Object.defineProperty(fn, 'called', {
    get() { return stub.called; },
    set(v) { stub.called = v; },
    enumerable: true
  });
  Object.defineProperty(fn, 'callCount', {
    get() { return stub.callCount; },
    set(v) { stub.callCount = v; },
    enumerable: true
  });
  
  // Make it chainable for .callsFake() and .returns()
  fn.callsFake = function(fakeFn) {
    const originalFn = fn;
    const wrapped = function(...args) {
      stub.called = true;
      stub.callCount++;
      return fakeFn.apply(this, args);
    };
    // Copy properties to wrapped function
    Object.defineProperty(wrapped, 'called', {
      get() { return stub.called; },
      set(v) { stub.called = v; },
      enumerable: true
    });
    Object.defineProperty(wrapped, 'callCount', {
      get() { return stub.callCount; },
      set(v) { stub.callCount = v; },
      enumerable: true
    });
    return wrapped;
  };
  
  fn.returns = function(value) {
    const wrapped = function(...args) {
      stub.called = true;
      stub.callCount++;
      return value;
    };
    Object.defineProperty(wrapped, 'called', {
      get() { return stub.called; },
      set(v) { stub.called = v; },
      enumerable: true
    });
    Object.defineProperty(wrapped, 'callCount', {
      get() { return stub.callCount; },
      set(v) { stub.callCount = v; },
      enumerable: true
    });
    return wrapped;
  };
  
  return fn;
}


function buildCommentBody(review, type) {
  const header = type === 'pr_review' ? '## Z.ai Code Review' : '## Z.ai Response';
  return `${header}\n\n${review}\n\n${COMMENT_MARKER}`;
}

function buildAskPrompt(question, context) {
  return `Question: ${question}\n\nContext:\n${context}`;
}

let mockOctokit;
let mockGithub;
let mockApiClient;
let originalRequireGithub;

describe('Command Pipeline Integration', () => {
  beforeEach(() => {
    originalRequireGithub = require.cache[require.resolve('@actions/github')];

    mockApiClient = api.createApiClient({ timeout: 5000, maxRetries: 0 });

    mockOctokit = {
      rest: {
        pulls: {
          listFiles: async () => ({ data: createMockFiles(['src/test.js']) })
        },
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: { id: 123, body: '' } }),
          updateComment: async () => ({ data: { id: 123, body: '' } })
        },
        repos: {
          getCollaboratorPermission: async () => ({
            data: { permission: 'write' }
          })
        },
        reactions: {
          createForIssueComment: async () => ({ data: { content: 'eyes' } })
        }
      }
    };

    mockGithub = {
      context: {
        payload: {},
        eventName: 'issue_comment',
        repo: { owner: 'test-owner', repo: 'test-repo' }
      },
      getOctokit: () => mockOctokit
    };

    require.cache[require.resolve('@actions/github')].exports = mockGithub;
  });

  test('/zai ask command parses correctly', () => {
    const payload = createIssueCommentEvent('created', '/zai ask what is this?', 42, 'test-owner', 'test-repo', 'test-user');
    mockGithub.context.payload = payload;

    const parseResult = commands.parseCommand('/zai ask what is this?');
    expect(parseResult.command).toBe('ask');
    expect(parseResult.error).toBe(null);
    expect(commands.isValid(parseResult)).toBe(true);
  });

  test('/zai help command parses correctly', () => {
    const parseResult = commands.parseCommand('/zai help');
    expect(parseResult.command).toBe('help');
    expect(parseResult.args.length).toBe(0);
  });

  test('event routing identifies PR comment events', () => {
    const payload = createIssueCommentEvent('created', '/zai ask test', 42);
    mockGithub.context.payload = payload;

    const eventType = events.getEventType(mockGithub.context);
    expect(eventType).toBe('issue_comment_pr');

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    expect(shouldProcess.process).toBe(true);
  });

  test('authorized user passes authorization check', async () => {
    mockOctokit.rest.repos.getCollaboratorPermission = async () => ({
      data: { permission: 'write' }
    });

    const authResult = await auth.checkAuthorization(
      mockOctokit,
      mockGithub.context,
      { login: 'test-user' }
    );

    expect(authResult.authorized).toBe(true);
  });

  // Now permissive - all identifiable users allowed
  test('any identifiable user passes authorization check', async () => {
    mockOctokit.rest.repos.getCollaboratorPermission = async () => {
      const error = new Error('Not Found');
      error.status = 404;
      throw error;
    };

    const authResult = await auth.checkAuthorization(
      mockOctokit,
      mockGithub.context,
      { login: 'unknown-user' }
    );

    expect(authResult.authorized).toBe(true);
  });

  test('review comment auth falls back to sender when comment.user is missing', async () => {
    const payload = {
      action: 'created',
      pull_request: {
        number: 42,
        user: { login: 'dependabot[bot]' },
        head: { repo: { full_name: 'test-owner/test-repo' } },
        base: { repo: { full_name: 'test-owner/test-repo' } },
      },
      comment: {
        id: 777,
        body: '/zai explain',
        author_association: 'OWNER',
      },
      repository: {
        owner: { login: 'test-owner' },
        name: 'test-repo',
      },
      sender: {
        login: 'test-owner',
        type: 'User',
      },
    };

    mockGithub.context.eventName = 'pull_request_review_comment';
    mockGithub.context.payload = payload;

    const commenter = payload.comment?.user || payload.sender;
    const authResult = await auth.checkForkAuthorization(
      mockOctokit,
      mockGithub.context,
      commenter
    );

    expect(commenter.login).toBe('test-owner');
    expect(authResult.authorized).toBe(true);
  });

  test('ask handler executes and formats response', () => {
    const handlerModule = handlers.ask;
    expect(handlerModule).toBeTruthy();

    const validation = handlerModule.validateArgs(['what', 'is', 'this?']);
    expect(validation.valid).toBe(true);

    const prompt = handlerModule.buildPrompt('What is this?', 'PR context here');
    expect(prompt.includes('What is this?')).toBe(true);
    expect(prompt.includes('PR context here')).toBe(true);
  });

  test('help handler returns help text', async () => {
    const handlerModule = handlers.help;
    expect(handlerModule).toBeTruthy();

    mockGithub.context.payload = {
      pull_request: { number: 42 },
      comment: { id: 123 }
    };

    const helpResponse = await handlerModule.handleHelpCommand({
      octokit: mockOctokit,
      context: mockGithub.context,
      commenter: { login: 'test-user' },
      args: [],
      logger: { info: () => {} }
    });

    expect(helpResponse.success).toBe(true);
  });

  test('full pipeline: authorized user asks question', async () => {
    const payload = createIssueCommentEvent('created', '/zai ask what does this do?', 42, 'test-owner', 'test-repo', 'test-user');
    mockGithub.context.payload = payload;

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    expect(shouldProcess.process).toBe(true);

    const parseResult = commands.parseCommand('/zai ask what does this do?');
    expect(commands.isValid(parseResult)).toBe(true);

    const authResult = await auth.checkAuthorization(
      mockOctokit,
      mockGithub.context,
      { login: 'test-user' }
    );
    expect(authResult.authorized).toBe(true);

    const handlerModule = handlers.ask;
    const context = 'PR context: src/test.js modified';
    const prompt = handlerModule.buildPrompt(parseResult.args.join(' '), context);

    expect(prompt.includes('what does this do?')).toBe(true);
  });

  test('unknown command returns error', () => {
    const parseResult = commands.parseCommand('/zai unknown-cmd');
    expect(parseResult.error.type).toBe('unknown_command');
  });

  test('malformed input returns error', () => {
    const parseResult = commands.parseCommand('hello world');
    expect(parseResult.error.type).toBe('malformed_input');
  });

  test('empty input returns error', () => {
    const parseResult = commands.parseCommand('');
    expect(parseResult.error.type).toBe('empty_input');
  });
});



// =====================================================
// RUNTIME-PATH INTEGRATION TESTS (Full Command Matrix)
// =====================================================

describe('Runtime-Path Command Matrix', () => {
  let mockOctokit;
  let mockGithub;
  let originalRequireGithub;
  let originalRequireCore;
  let coreSpy;

  beforeEach(() => {
    // Save original module cache
    // Save original module cache
    originalRequireGithub = require.cache[require.resolve('@actions/github')];
    originalRequireCore = require.cache[require.resolve('@actions/core')];

    // Create mock Octokit
    mockOctokit = {
      rest: {
        pulls: {
          listFiles: async () => ({ 
            data: createMockFiles(['src/test.js', 'src/utils.js']) 
          })
        },
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async () => ({ data: { id: 123, body: '' } }),
          updateComment: async () => ({ data: { id: 123, body: '' } })
        },
        repos: {
          getCollaboratorPermission: async () => ({
            data: { permission: 'write' }
          })
        },
        reactions: {
          createForIssueComment: async () => ({ data: { content: 'eyes' } })
        }
      }
    };

    mockGithub = {
      context: {
        payload: {},
        eventName: 'issue_comment',
        repo: { owner: 'test-owner', repo: 'test-repo' }
      },
      getOctokit: () => mockOctokit
    };

    // Mock core with spy
    const mockCore = {
      getInput: createStub().callsFake((name, opts) => {
        if (name === 'ZAI_API_KEY') return 'test-api-key';
        if (name === 'ZAI_MODEL') return 'glm-4.7';
        if (name === 'GITHUB_TOKEN') return 'test-token';
        return opts?.required ? '' : '';
      }),
      info: createStub(),
      warning: createStub(),
      error: createStub(),
      setFailed: createStub(),
      setOutput: createStub(),
      startGroup: createStub(),
      endGroup: createStub()
    };
    coreSpy = mockCore;

    require.cache[require.resolve('@actions/github')].exports = mockGithub;
    require.cache[require.resolve('@actions/core')].exports = mockCore;
  });

  afterEach(() => {
    // Restore original modules
    if (originalRequireGithub) {
      require.cache[require.resolve('@actions/github')] = originalRequireGithub;
    }
    if (originalRequireCore) {
      require.cache[require.resolve('@actions/core')] = originalRequireCore;
    }
  });

  // Helper to run full pipeline simulation
  async function runFullPipeline(commandText, commenter = 'test-user') {
    const payload = createIssueCommentEvent('created', commandText, 42, 'test-owner', 'test-repo', commenter);
    mockGithub.context.payload = payload;

    // Step 1: Event routing
    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    if (!shouldProcess.process) {
      return { stage: 'routing', success: false, reason: shouldProcess.reason };
    }

    // Step 2: Command parsing
    const parseResult = commands.parseCommand(commandText);
    if (!commands.isValid(parseResult)) {
      return { stage: 'parsing', success: false, error: parseResult.error };
    }

    // Step 3: Authorization check
    const authResult = await auth.checkAuthorization(
      mockOctokit,
      mockGithub.context,
      { login: commenter }
    );
    if (!authResult.authorized) {
      return { stage: 'auth', success: false, reason: authResult.reason };
    }

    // Step 4: Handler dispatch - verify handler exists
    const handler = handlers.getHandler(parseResult.command);
    if (!handler) {
      return { stage: 'dispatch', success: false, error: 'no handler' };
    }

    return { 
      stage: 'complete', 
      success: true, 
      command: parseResult.command, 
      args: parseResult.args 
    };
  }

  // =====================================================
  // FULL RUNTIME PATH TESTS - All Six Commands
  // =====================================================

  test('/zai ask passes full pipeline', async () => {
    const result = await runFullPipeline('/zai ask what does this function do?');
    
    expect(result.success).toBe(true);
    expect(result.stage).toBe('complete');
    expect(result.command).toBe('ask');
    expect(result.args.join(' ')).toBe('what does this function do?');
    
    // Note: core.getInput is not called in pipeline component tests
  });

  test('/zai help passes full pipeline', async () => {
    const result = await runFullPipeline('/zai help');
    
    expect(result.success).toBe(true);
    expect(result.stage).toBe('complete');
    expect(result.command).toBe('help');
    expect(result.args.length).toBe(0);
  });

  test('/zai review passes full pipeline', async () => {
    const result = await runFullPipeline('/zai review');
    
    expect(result.success).toBe(true);
    expect(result.stage).toBe('complete');
    expect(result.command).toBe('review');
  });

  test('/zai explain passes full pipeline', async () => {
    const result = await runFullPipeline('/zai explain 10-20');
    
    expect(result.success).toBe(true);
    expect(result.stage).toBe('complete');
    expect(result.command).toBe('explain');
    expect(result.args.join(' ')).toBe('10-20');
  });

  test('/zai suggest fails at parsing (removed command)', async () => {
    const result = await runFullPipeline('/zai suggest');
    
    expect(result.success).toBe(false);
    expect(result.stage).toBe('parsing');
    expect(result.error.type).toBe('unknown_command');
  });

  test('/zai compare fails at parsing (removed command)', async () => {
    const result = await runFullPipeline('/zai compare');
    
    expect(result.success).toBe(false);
    expect(result.stage).toBe('parsing');
    expect(result.error.type).toBe('unknown_command');
  });

  // =====================================================
  // ALIAS TESTS (@zai-bot prefix)
  // =====================================================

  test('@zai-bot ask passes full pipeline', async () => {
    const result = await runFullPipeline('@zai-bot ask what is this?');
    
    expect(result.success).toBe(true);
    expect(result.command).toBe('ask');
  });

  test('@zai-bot review passes full pipeline', async () => {
    const result = await runFullPipeline('@zai-bot review');
    
    expect(result.success).toBe(true);
    expect(result.command).toBe('review');
  });

  // =====================================================
  // UNAUTHORIZED TESTS
  // =====================================================

  // Now permissive - all identifiable users allowed
  test('any user passes auth (permissive)', async () => {
    mockOctokit.rest.repos.getCollaboratorPermission = async () => {
      const error = new Error('Not Found');
      error.status = 404;
      throw error;
    };

    const result = await runFullPipeline('/zai ask test', 'unknown-user');
    expect(result.success).toBe(true);
});

  // Now permissive - fork users also allowed
  test('fork user passes auth (permissive)', async () => {
    mockOctokit.rest.repos.getCollaboratorPermission = async () => {
      const error = new Error('Not Found');
      error.status = 404;
      throw error;
    };

    const result = await runFullPipeline('/zai review', 'external-user');
    expect(result.success).toBe(true);
  });

  // =====================================================
  // MALFORMED COMMAND TESTS
  // =====================================================

  test('malformed command fails at parsing stage', async () => {
    const result = await runFullPipeline('just some random text');
    
    expect(result.success).toBe(false);
    expect(result.stage).toBe('parsing');
    expect(result.error.type).toBe('malformed_input');
  });

  test('empty command fails at parsing stage', async () => {
    const result = await runFullPipeline('');
    
    expect(result.success).toBe(false);
    expect(result.stage).toBe('parsing');
    expect(result.error.type).toBe('empty_input');
  });

  test('unknown command fails at parsing stage', async () => {
    const result = await runFullPipeline('/zai unknown-command');
    
    expect(result.success).toBe(false);
    expect(result.stage).toBe('parsing');
    expect(result.error.type).toBe('unknown_command');
  });

  test('command without zai prefix fails at parsing stage', async () => {
    const result = await runFullPipeline('/ask help');
    
    expect(result.success).toBe(false);
    expect(result.stage).toBe('parsing');
    expect(result.error.type).toBe('malformed_input');
  });

  // =====================================================
  // EVENT ROUTING TESTS
  // =====================================================

  test('non-PR issue comment is skipped', async () => {
    // Create an issue comment (not PR comment)
    const payload = createIssueCommentEvent('created', '/zai ask test', 42, 'test-owner', 'test-repo', 'test-user');
    delete payload.issue.pull_request; // Remove PR association
    mockGithub.context.payload = payload;

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    expect(shouldProcess.process).toBe(false);
    expect(shouldProcess.reason).toBe('non-PR issue comment - not supported');
  });

  test('deleted comment action is processed', async () => {
    const payload = createIssueCommentEvent('deleted', '/zai ask test', 42);
    mockGithub.context.payload = payload;

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    // Source code does not filter on action, so deleted comments are processed
    expect(shouldProcess.process).toBe(true);
  });

  test('bot comment is skipped', async () => {
    const payload = createIssueCommentEvent('created', '/zai ask test', 42, 'test-owner', 'test-repo', 'test-user');
    payload.comment.user.type = 'Bot';
    mockGithub.context.payload = payload;

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    expect(shouldProcess.process).toBe(false);
  });

  // =====================================================
  // HANDLER DISPATCH TESTS
  // =====================================================

  test('all six commands have handlers', () => {
    const commands = ['ask', 'help', 'review', 'explain', 'describe', 'impact'];
    
    for (const cmd of commands) {
      const handler = handlers.getHandler(cmd);
      expect(handler, `Handler for ${cmd} should exist`).toBeTruthy();
    }
  });

  test('removed commands have no handlers', () => {
    expect(handlers.getHandler('suggest')).toBe(null);
    expect(handlers.getHandler('compare')).toBe(null);
  });

  test('handler returns correct command list', () => {
    const allCommands = handlers.getAllCommands();
    
    expect(allCommands.length).toBe(6);
    expect(allCommands).toContain('ask');
    expect(allCommands).toContain('help');
    expect(allCommands).toContain('review');
    expect(allCommands).toContain('explain');
    expect(allCommands).toContain('describe');
    expect(allCommands).toContain('impact');
    expect(allCommands).not.toContain('suggest');
    expect(allCommands).not.toContain('compare');
  });

  // =====================================================
  // ERROR RESPONSE TESTS
  // =====================================================

  test('parse error produces correct error type', async () => {
    const payload = createIssueCommentEvent('created', 'not a command', 42);
    mockGithub.context.payload = payload;

    const result = await runFullPipeline('not a command');
    
    expect(result.stage).toBe('parsing');
    expect(result.error.type).toBe('malformed_input');
  });

  // Now permissive - all identifiable users pass auth
  test('any user passes auth (permissive)', async () => {
    mockOctokit.rest.repos.getCollaboratorPermission = async () => {
      throw new Error('Not Found');
    };

    const result = await runFullPipeline('/zai review', 'unauthorized-user');
    expect(result.success).toBe(true);
  });
});
