const { test, describe } = require('node:test');
const assert = require('node:assert');
const askHandler = require('../src/lib/handlers/ask.js');
const helpHandler = require('../src/lib/handlers/help.js');
const handlers = require('../src/lib/handlers/index.js');

describe('ask handler', () => {
  test('validateArgs returns error for empty args', () => {
    const result = askHandler.validateArgs([]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Please provide a question'));
  });

  test('validateArgs returns error for whitespace-only args', () => {
    const result = askHandler.validateArgs(['   ', '']);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Please provide a question'));
  });

  test('validateArgs returns valid for non-empty args', () => {
    const result = askHandler.validateArgs(['what', 'is', 'this']);
    assert.strictEqual(result.valid, true);
  });

  test('buildPrompt builds correct prompt', () => {
    const prompt = askHandler.buildPrompt('What is this?', 'PR context here');
    assert.ok(prompt.includes('What is this?'));
    assert.ok(prompt.includes('PR context here'));
    assert.ok(prompt.includes('Question:'));
  });

  test('buildPrompt builds structured contextual prompt', () => {
    const prompt = askHandler.buildPrompt('What changed?', {
      prContext: 'PR title and description',
      fileContext: 'diff and file snippets',
      conversationHistory: 'thread transcript',
    });

    assert.ok(prompt.includes('<pr_context>'));
    assert.ok(prompt.includes('<file_context>'));
    assert.ok(prompt.includes('<conversation_history>'));
    assert.ok(prompt.includes('<user_query>'));
    assert.ok(prompt.includes('What changed?'));
  });

  test('getThreadTranscript returns chronologically sorted last comments', async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              {
                created_at: '2026-02-01T10:00:01Z',
                body: 'later comment',
                user: { login: 'dev2', type: 'User' },
              },
              {
                created_at: '2026-02-01T10:00:00Z',
                body: 'earlier comment',
                user: { login: 'dev1', type: 'User' },
              },
            ],
          }),
        },
      },
    };

    const githubContext = {
      repo: { owner: 'AndreiDrang', repo: 'zai-code-bot' },
      payload: { issue: { number: 42 } },
    };

    const transcript = await askHandler.getThreadTranscript(octokit, githubContext, { limit: 20 });
    assert.ok(transcript.includes('earlier comment'));
    assert.ok(transcript.includes('later comment'));
    assert.ok(transcript.indexOf('earlier comment') < transcript.indexOf('later comment'));
  });

  test('getThreadTranscript handles rate limit errors safely', async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: async () => {
            const err = new Error('API rate limit exceeded');
            err.status = 429;
            throw err;
          },
        },
      },
    };

    const githubContext = {
      repo: { owner: 'AndreiDrang', repo: 'zai-code-bot' },
      payload: { issue: { number: 42 } },
    };

    const transcript = await askHandler.getThreadTranscript(octokit, githubContext);
    assert.ok(transcript.includes('rate limits'));
  });

  test('getRelevantFileContent includes focused file and diff context', async () => {
    const octokit = {
      rest: {
        pulls: {
          listFiles: async () => ({
            data: [
              {
                filename: 'src/lib/handlers/ask.js',
                status: 'modified',
                patch: '@@ -1,1 +1,2 @@\n-old\n+new',
              },
            ],
          }),
        },
        repos: {
          getContent: async () => ({
            data: {
              content: Buffer.from('const x = 1;').toString('base64'),
            },
          }),
        },
      },
    };

    const githubContext = {
      repo: { owner: 'AndreiDrang', repo: 'zai-code-bot' },
      payload: {
        issue: { number: 42 },
        pull_request: { head: { sha: 'abc123' } },
        comment: {
          path: 'src/lib/handlers/ask.js',
          diff_hunk: '@@ -1,1 +1,2 @@\n-old\n+new',
        },
      },
    };

    const fileContext = await askHandler.getRelevantFileContent(octokit, githubContext);
    assert.ok(fileContext.includes('Focused file from thread'));
    assert.ok(fileContext.includes('PR diff context'));
    assert.ok(fileContext.includes('Raw file snapshot'));
  });

  test('formatResponse formats correctly', () => {
    const response = askHandler.formatResponse('This is the answer.', 'What is this?');
    assert.ok(response.includes('This is the answer.'));
    assert.ok(response.includes('What is this?'));
    assert.ok(response.includes('Answer to:'));
  });
});

describe('help handler', () => {
  test('HELP_TEXT contains all commands', () => {
    assert.ok(helpHandler.HELP_TEXT.includes('/zai ask'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai review'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai explain'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai suggest'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai compare'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai help'));
  });

  test('HELP_MARKER is defined', () => {
    assert.strictEqual(typeof helpHandler.HELP_MARKER, 'string');
    assert.ok(helpHandler.HELP_MARKER.length > 0);
  });
});

describe('handler registry', () => {
  test('getHandler returns ask handler', () => {
    const handler = handlers.getHandler('ask');
    assert.strictEqual(typeof handler, 'function');
  });

  test('getHandler returns help handler', () => {
    const handler = handlers.getHandler('help');
    assert.strictEqual(typeof handler, 'function');
  });

  test('getHandler returns null for unknown command', () => {
    const handler = handlers.getHandler('unknown');
    assert.strictEqual(handler, null);
  });

  test('hasHandler returns true for known commands', () => {
    assert.strictEqual(handlers.hasHandler('ask'), true);
    assert.strictEqual(handlers.hasHandler('help'), true);
  });

  test('hasHandler returns false for unknown commands', () => {
    assert.strictEqual(handlers.hasHandler('unknown'), false);
  });

  test('getAllCommands returns all commands', () => {
    const commands = handlers.getAllCommands();
    assert.ok(commands.includes('ask'));
    assert.ok(commands.includes('help'));
  });
});
