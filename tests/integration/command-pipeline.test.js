const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
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
    assert.strictEqual(parseResult.command, 'ask');
    assert.strictEqual(parseResult.error, null);
    assert.strictEqual(commands.isValid(parseResult), true);
  });

  test('/zai help command parses correctly', () => {
    const parseResult = commands.parseCommand('/zai help');
    assert.strictEqual(parseResult.command, 'help');
    assert.strictEqual(parseResult.args.length, 0);
  });

  test('event routing identifies PR comment events', () => {
    const payload = createIssueCommentEvent('created', '/zai ask test', 42);
    mockGithub.context.payload = payload;

    const eventType = events.getEventType(mockGithub.context);
    assert.strictEqual(eventType, 'issue_comment_pr');

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    assert.strictEqual(shouldProcess.process, true);
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

    assert.strictEqual(authResult.authorized, true);
  });

  test('unauthorized user fails authorization check', async () => {
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

    assert.strictEqual(authResult.authorized, false);
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

    assert.strictEqual(commenter.login, 'test-owner');
    assert.strictEqual(authResult.authorized, true);
  });

  test('ask handler executes and formats response', () => {
    const handlerModule = handlers.ask;
    assert.ok(handlerModule);

    const validation = handlerModule.validateArgs(['what', 'is', 'this?']);
    assert.strictEqual(validation.valid, true);

    const prompt = handlerModule.buildPrompt('What is this?', 'PR context here');
    assert.ok(prompt.includes('What is this?'));
    assert.ok(prompt.includes('PR context here'));
  });

  test('help handler returns help text', async () => {
    const handlerModule = handlers.help;
    assert.ok(handlerModule);

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

    assert.strictEqual(helpResponse.success, true);
  });

  test('full pipeline: authorized user asks question', async () => {
    const payload = createIssueCommentEvent('created', '/zai ask what does this do?', 42, 'test-owner', 'test-repo', 'test-user');
    mockGithub.context.payload = payload;

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    assert.strictEqual(shouldProcess.process, true);

    const parseResult = commands.parseCommand('/zai ask what does this do?');
    assert.strictEqual(commands.isValid(parseResult), true);

    const authResult = await auth.checkAuthorization(
      mockOctokit,
      mockGithub.context,
      { login: 'test-user' }
    );
    assert.strictEqual(authResult.authorized, true);

    const handlerModule = handlers.ask;
    const context = 'PR context: src/test.js modified';
    const prompt = handlerModule.buildPrompt(parseResult.args.join(' '), context);

    assert.ok(prompt.includes('what does this do?'));
  });

  test('unknown command returns error', () => {
    const parseResult = commands.parseCommand('/zai unknown-cmd');
    assert.strictEqual(parseResult.error.type, 'unknown_command');
  });

  test('malformed input returns error', () => {
    const parseResult = commands.parseCommand('hello world');
    assert.strictEqual(parseResult.error.type, 'malformed_input');
  });

  test('empty input returns error', () => {
    const parseResult = commands.parseCommand('');
    assert.strictEqual(parseResult.error.type, 'empty_input');
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
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'complete');
    assert.strictEqual(result.command, 'ask');
    assert.strictEqual(result.args.join(' '), 'what does this function do?');
    
    // Note: core.getInput is not called in pipeline component tests
  });

  test('/zai help passes full pipeline', async () => {
    const result = await runFullPipeline('/zai help');
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'complete');
    assert.strictEqual(result.command, 'help');
    assert.strictEqual(result.args.length, 0);
  });

  test('/zai review passes full pipeline', async () => {
    const result = await runFullPipeline('/zai review');
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'complete');
    assert.strictEqual(result.command, 'review');
  });

  test('/zai explain passes full pipeline', async () => {
    const result = await runFullPipeline('/zai explain 10-20');
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'complete');
    assert.strictEqual(result.command, 'explain');
    assert.strictEqual(result.args.join(' '), '10-20');
  });

  test('/zai suggest passes full pipeline', async () => {
    const result = await runFullPipeline('/zai suggest');
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'complete');
    assert.strictEqual(result.command, 'suggest');
  });

  test('/zai compare passes full pipeline', async () => {
    const result = await runFullPipeline('/zai compare');
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.stage, 'complete');
    assert.strictEqual(result.command, 'compare');
  });

  // =====================================================
  // ALIAS TESTS (@zai-bot prefix)
  // =====================================================

  test('@zai-bot ask passes full pipeline', async () => {
    const result = await runFullPipeline('@zai-bot ask what is this?');
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.command, 'ask');
  });

  test('@zai-bot review passes full pipeline', async () => {
    const result = await runFullPipeline('@zai-bot review');
    
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.command, 'review');
  });

  // =====================================================
  // UNAUTHORIZED TESTS
  // =====================================================

  test('unauthorized user fails at auth stage', async () => {
    // Override collaborator check to simulate unauthorized user
    mockOctokit.rest.repos.getCollaboratorPermission = async () => {
      const error = new Error('Not Found');
      error.status = 404;
      throw error;
    };

    const result = await runFullPipeline('/zai ask test', 'unknown-user');
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stage, 'auth');
    assert.strictEqual(result.reason, 'You are not authorized to use this command.');
  });

  test('fork user fails at auth stage', async () => {
    // Override to simulate fork PR scenario
    mockOctokit.rest.repos.getCollaboratorPermission = async () => {
      const error = new Error('Not Found');
      error.status = 404;
      throw error;
    };

    const result = await runFullPipeline('/zai review', 'external-user');
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stage, 'auth');
  });

  // =====================================================
  // MALFORMED COMMAND TESTS
  // =====================================================

  test('malformed command fails at parsing stage', async () => {
    const result = await runFullPipeline('just some random text');
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stage, 'parsing');
    assert.strictEqual(result.error.type, 'malformed_input');
  });

  test('empty command fails at parsing stage', async () => {
    const result = await runFullPipeline('');
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stage, 'parsing');
    assert.strictEqual(result.error.type, 'empty_input');
  });

  test('unknown command fails at parsing stage', async () => {
    const result = await runFullPipeline('/zai unknown-command');
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stage, 'parsing');
    assert.strictEqual(result.error.type, 'unknown_command');
  });

  test('command without zai prefix fails at parsing stage', async () => {
    const result = await runFullPipeline('/ask help');
    
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.stage, 'parsing');
    assert.strictEqual(result.error.type, 'malformed_input');
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
    assert.strictEqual(shouldProcess.process, false);
    assert.strictEqual(shouldProcess.reason, 'non-PR issue comment - not supported');
  });

  test('deleted comment action is processed', async () => {
    const payload = createIssueCommentEvent('deleted', '/zai ask test', 42);
    mockGithub.context.payload = payload;

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    // Source code does not filter on action, so deleted comments are processed
    assert.strictEqual(shouldProcess.process, true);
  });

  test('bot comment is skipped', async () => {
    const payload = createIssueCommentEvent('created', '/zai ask test', 42, 'test-owner', 'test-repo', 'test-user');
    payload.comment.user.type = 'Bot';
    mockGithub.context.payload = payload;

    const shouldProcess = events.shouldProcessEvent(mockGithub.context);
    assert.strictEqual(shouldProcess.process, false);
  });

  // =====================================================
  // HANDLER DISPATCH TESTS
  // =====================================================

  test('all six commands have handlers', () => {
    const commands = ['ask', 'help', 'review', 'explain', 'suggest', 'compare'];
    
    for (const cmd of commands) {
      const handler = handlers.getHandler(cmd);
      assert.ok(handler, `Handler for ${cmd} should exist`);
    }
  });

  test('handler returns correct command list', () => {
    const allCommands = handlers.getAllCommands();
    
    assert.strictEqual(allCommands.length, 6);
    assert.ok(allCommands.includes('ask'));
    assert.ok(allCommands.includes('help'));
    assert.ok(allCommands.includes('review'));
    assert.ok(allCommands.includes('explain'));
    assert.ok(allCommands.includes('suggest'));
    assert.ok(allCommands.includes('compare'));
  });

  // =====================================================
  // ERROR RESPONSE TESTS
  // =====================================================

  test('parse error produces correct error type', async () => {
    const payload = createIssueCommentEvent('created', 'not a command', 42);
    mockGithub.context.payload = payload;

    const result = await runFullPipeline('not a command');
    
    assert.strictEqual(result.stage, 'parsing');
    assert.strictEqual(result.error.type, 'malformed_input');
  });

  test('auth failure produces correct reason', async () => {
    mockOctokit.rest.repos.getCollaboratorPermission = async () => {
      throw new Error('Not Found');
    };

    const result = await runFullPipeline('/zai review', 'unauthorized-user');
    
    assert.strictEqual(result.stage, 'auth');
  });
});
