import { test, describe, expect } from 'vitest';
const askHandler = require('../src/lib/handlers/ask.js');
const helpHandler = require('../src/lib/handlers/help.js');
const handlers = require('../src/lib/handlers/index.js');

describe('ask handler', () => {
  test('validateArgs returns error for empty args', () => {
    const result = askHandler.validateArgs([]);
    expect(result.valid).toBe(false);
    expect(result.error.includes('Please provide a question')).toBe(true);
  });

  test('validateArgs returns error for whitespace-only args', () => {
    const result = askHandler.validateArgs(['   ', '']);
    expect(result.valid).toBe(false);
    expect(result.error.includes('Please provide a question')).toBe(true);
  });

  test('validateArgs returns valid for non-empty args', () => {
    const result = askHandler.validateArgs(['what', 'is', 'this']);
    expect(result.valid).toBe(true);
  });

  test('buildPrompt builds correct prompt', () => {
    const prompt = askHandler.buildPrompt('What is this?', 'PR context here');
    expect(prompt.includes('What is this?')).toBe(true);
    expect(prompt.includes('PR context here')).toBe(true);
    expect(prompt.includes('Question:')).toBe(true);
  });

  test('buildPrompt builds structured contextual prompt', () => {
    const prompt = askHandler.buildPrompt('What changed?', {
      prContext: 'PR title and description',
      fileContext: 'diff and file snippets',
      conversationHistory: 'thread transcript',
    });

    expect(prompt.includes('<pr_context>')).toBe(true);
    expect(prompt.includes('<file_context>')).toBe(true);
    expect(prompt.includes('<conversation_history>')).toBe(true);
    expect(prompt.includes('<user_query>')).toBe(true);
    expect(prompt.includes('What changed?')).toBe(true);
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
    expect(transcript).toContain('earlier comment');
    expect(transcript).toContain('later comment');
    expect(transcript.indexOf('earlier comment')).toBeLessThan(transcript.indexOf('later comment'));
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
    expect(transcript.includes('rate limits')).toBe(true);
  });

  test('resolveRepoRef falls back to payload.repository when githubContext.repo is missing', () => {
    const githubContext = {
      payload: {
        repository: {
          owner: { login: 'AndreiDrang' },
          name: 'zai-code-bot',
        },
      },
    };

    const resolved = askHandler.resolveRepoRef(githubContext);
    expect(resolved.owner).toBe('AndreiDrang');
    expect(resolved.repo).toBe('zai-code-bot');
  });

  test('getThreadTranscript returns safe fallback when repo context is missing', async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
        },
      },
    };

    const githubContext = {
      payload: { issue: { number: 42 } },
    };

    const transcript = await askHandler.getThreadTranscript(octokit, githubContext);
    expect(transcript).toBe('No conversation history available.');
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
    expect(fileContext.includes('Focused file from thread')).toBe(true);
    expect(fileContext.includes('PR diff context')).toBe(true);
    expect(fileContext.includes('Raw file snapshot')).toBe(true);
  });

  test('formatResponse formats correctly', () => {
    const response = askHandler.formatResponse('This is the answer.', 'What is this?');
    expect(response.includes('This is the answer.')).toBe(true);
    expect(response.includes('What is this?')).toBe(true);
    expect(response.includes('Answer to:')).toBe(true);
  });
});

describe('help handler', () => {
  test('HELP_TEXT contains all commands', () => {
    expect(helpHandler.HELP_TEXT.includes('/zai ask')).toBe(true);
    expect(helpHandler.HELP_TEXT.includes('/zai review')).toBe(true);
    expect(helpHandler.HELP_TEXT.includes('/zai explain')).toBe(true);
    expect(helpHandler.HELP_TEXT.includes('/zai help')).toBe(true);
    expect(helpHandler.HELP_TEXT.includes('/zai describe')).toBe(true);
    expect(helpHandler.HELP_TEXT.includes('/zai impact')).toBe(true);
  });

  test('HELP_TEXT does not contain removed commands', () => {
    expect(helpHandler.HELP_TEXT.includes('/zai suggest')).toBeFalsy();
    expect(helpHandler.HELP_TEXT.includes('/zai compare')).toBeFalsy();
  });

  test('HELP_MARKER is defined', () => {
    expect(typeof helpHandler.HELP_MARKER).toBe('string');
    expect(helpHandler.HELP_MARKER.length > 0).toBeTruthy();
  });
});

describe('handler registry', () => {
  test('getHandler returns ask handler', () => {
    const handler = handlers.getHandler('ask');
    expect(typeof handler).toBe('function');
  });

  test('getHandler returns help handler', () => {
    const handler = handlers.getHandler('help');
    expect(typeof handler).toBe('function');
  });

  test('getHandler returns null for unknown command', () => {
    const handler = handlers.getHandler('unknown');
    expect(handler).toBe(null);
  });

  test('getHandler returns null for removed commands', () => {
    expect(handlers.getHandler('suggest')).toBe(null);
    expect(handlers.getHandler('compare')).toBe(null);
  });

  test('hasHandler returns true for known commands', () => {
    expect(handlers.hasHandler('ask')).toBe(true);
    expect(handlers.hasHandler('help')).toBe(true);
    expect(handlers.hasHandler('review')).toBe(true);
    expect(handlers.hasHandler('explain')).toBe(true);
    expect(handlers.hasHandler('describe')).toBe(true);
    expect(handlers.hasHandler('impact')).toBe(true);
  });

  test('hasHandler returns false for unknown commands', () => {
    expect(handlers.hasHandler('unknown')).toBe(false);
  });

  test('hasHandler returns false for removed commands', () => {
    expect(handlers.hasHandler('suggest')).toBe(false);
    expect(handlers.hasHandler('compare')).toBe(false);
  });

  test('getAllCommands returns all commands', () => {
    const commands = handlers.getAllCommands();
    expect(commands.includes('ask')).toBe(true);
    expect(commands.includes('help')).toBe(true);
    expect(commands.includes('review')).toBe(true);
    expect(commands.includes('explain')).toBe(true);
    expect(commands.includes('describe')).toBe(true);
    expect(commands.includes('impact')).toBe(true);
    expect(commands.length).toBe(6);
  });

  test('getAllCommands does not include removed commands', () => {
    const commands = handlers.getAllCommands();
    expect(commands.includes('suggest')).toBe(false);
    expect(commands.includes('compare')).toBeFalsy();
  });
});
