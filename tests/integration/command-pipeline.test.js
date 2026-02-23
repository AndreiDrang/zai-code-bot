const { test, describe, beforeEach } = require('node:test');
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
