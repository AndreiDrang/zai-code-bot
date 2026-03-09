import { test, describe, expect } from 'vitest';
const {
  truncateContext,
  extractLines,
  validateRange,
  getDefaultMaxChars,
  DEFAULT_MAX_CHARS,
  buildHandlerContext,
  ContextError,
} = require('../src/lib/context');

describe('truncateContext', () => {
  test('returns original content when under maxChars', () => {
    const content = 'short content';
    const result = truncateContext(content, 100);
    expect(result.content).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.omitted).toBe(0);
  });

  test('truncates content and adds marker when over maxChars', () => {
    const content = 'a'.repeat(1000);
    const result = truncateContext(content, 100);
    expect(result.truncated).toBe(true);
    expect(result.content.includes('[truncated,')).toBe(true);
    expect(result.content.includes('chars omitted]')).toBe(true);
    expect(result.content.length > 50).toBeTruthy();
    expect(result.omitted > 0).toBeTruthy();
    expect(result.content.length <= 100).toBeTruthy();
  });

  test('uses default maxChars of 8000', () => {
    const content = 'a'.repeat(10000);
    const result = truncateContext(content);
    expect(result.truncated).toBe(true);
    expect(DEFAULT_MAX_CHARS).toBe(8000);
  });

  test('throws TypeError for non-string content', () => {
    expect(() => () => truncateContext(123), TypeError);
    expect(() => () => truncateContext(null), TypeError);
  });

  test('throws TypeError for invalid maxChars', () => {
    expect(() => () => truncateContext('test', 0), TypeError);
    expect(() => () => truncateContext('test', -1), TypeError);
    expect(() => () => truncateContext('test', 'abc'), TypeError);
  });

  test('handles edge case when maxChars is smaller than marker', () => {
    const content = 'hello world';
    const result = truncateContext(content, 5);
    expect(result.truncated).toBe(true);
    expect(result.content.includes('[truncated,')).toBe(true);
  });
});

describe('extractLines', () => {
  const sampleContent = `line1
line2
line3
line4
line5`;

  test('extracts valid line range', () => {
    const result = extractLines(sampleContent, 2, 4);
    expect(result.valid).toBe(true);
    expect(result.lines).toEqual(['line2', 'line3', 'line4']);
  });

  test('extracts single line', () => {
    const result = extractLines(sampleContent, 3, 3);
    expect(result.valid).toBe(true);
    expect(result.lines).toEqual(['line3']);
  });

  test('extracts full range', () => {
    const result = extractLines(sampleContent, 1, 5);
    expect(result.valid).toBe(true);
    expect(result.lines.length).toBe(5);
  });

  test('returns error for start > end', () => {
    const result = extractLines(sampleContent, 4, 2);
    expect(result.valid).toBe(false);
    expect(result.error.includes('cannot exceed')).toBe(true);
  });

  test('returns error for start < 1', () => {
    const result = extractLines(sampleContent, 0, 3);
    expect(result.valid).toBe(false);
    expect(result.error.includes('must be >= 1')).toBe(true);
  });

  test('returns error for end > maxLines', () => {
    const result = extractLines(sampleContent, 1, 10);
    expect(result.valid).toBe(false);
    expect(result.error.includes('exceeds content')).toBe(true);
  });

  test('throws TypeError for non-string content', () => {
    expect(() => () => extractLines(123, 1, 3), TypeError);
  });
});

describe('validateRange', () => {
  test('returns valid for correct range', () => {
    const result = validateRange(1, 10, 10);
    expect(result.valid).toBe(true);
    expect(result.error).toBe(undefined);
  });

  test('returns error for non-number parameters', () => {
    const result = validateRange('1', 10, 10);
    expect(result.valid).toBe(false);
    expect(result.error.includes('must be numbers')).toBe(true);
  });

  test('returns error for non-integer parameters', () => {
    const result = validateRange(1.5, 10, 10);
    expect(result.valid).toBe(false);
    expect(result.error.includes('integers')).toBe(true);
  });

  test('returns error for startLine < 1', () => {
    const result = validateRange(0, 5, 10);
    expect(result.valid).toBe(false);
    expect(result.error.includes('must be >= 1')).toBe(true);
  });

  test('returns error for endLine > maxLines', () => {
    const result = validateRange(1, 15, 10);
    expect(result.valid).toBe(false);
    expect(result.error.includes('exceeds content')).toBe(true);
  });

  test('returns error for startLine > endLine', () => {
    const result = validateRange(8, 5, 10);
    expect(result.valid).toBe(false);
    expect(result.error.includes('cannot exceed')).toBe(true);
  });
});

describe('getDefaultMaxChars', () => {
  test('returns 8000', () => {
    expect(getDefaultMaxChars()).toBe(8000);
  });
});

describe('buildHandlerContext', () => {
  test('PR payload happy path - returns proper context with owner, repo, pullNumber', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: async () => ({ data: [{ filename: 'test.js' }] }),
        },
      },
    };
    const mockPayload = {
      repository: { owner: { login: 'owner' }, name: 'repo' },
      pull_request: { number: 1 },
      sender: { login: 'user' },
    };

    const result = await buildHandlerContext(mockPayload, mockOctokit, {});

    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
    expect(result.pullNumber).toBe(1);
    expect(result.sender).toBe('user');
    expect(result.changedFiles).toEqual([{ filename: 'test.js' }]);
  });

  test('Issue-comment-on-PR happy path - extracts PR number from issue', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: async () => ({ data: [] }),
        },
      },
    };
    const mockPayload = {
      repository: { owner: { login: 'owner' }, name: 'repo' },
      issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/o/r/pulls/42' } },
      comment: { id: 100, body: 'test comment' },
      sender: { login: 'user' },
    };

    const result = await buildHandlerContext(mockPayload, mockOctokit, {});

    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
    expect(result.pullNumber).toBe(42);
    expect(result.commentId).toBe(100);
    expect(result.commentBody).toBe('test comment');
  });

  test('fetchFiles: false option - skips file fetching', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: async () => { throw new Error('Should not be called'); },
        },
      },
    };
    const mockPayload = {
      repository: { owner: { login: 'owner' }, name: 'repo' },
      pull_request: { number: 1 },
      sender: { login: 'user' },
    };

    const result = await buildHandlerContext(mockPayload, mockOctokit, { fetchFiles: false });

    expect(result.owner).toBe('owner');
    expect(result.changedFiles).toBe(undefined);
  });

  test('Changed-file fetch failure stores _fileFetchError', async () => {
    const mockOctokit = {
      rest: {
        pulls: {
          listFiles: async () => { throw new Error('API error'); },
        },
      },
    };
    const mockPayload = {
      repository: { owner: { login: 'owner' }, name: 'repo' },
      pull_request: { number: 1 },
      sender: { login: 'user' },
    };

    const result = await buildHandlerContext(mockPayload, mockOctokit, {});

    expect(result.changedFiles).toEqual([]);
    expect(result._fileFetchError).toBe('API error');
  });

  test('Missing owner throws ContextError', async () => {
    const mockOctokit = {};
    const mockPayload = {
      repository: { name: 'repo' },
      pull_request: { number: 1 },
      sender: { login: 'user' },
    };

    await await expect(
      () => buildHandlerContext(mockPayload, mockOctokit, {}),
      (err) => err instanceof ContextError && err.field === 'owner'
    );
  });

  test('Missing repo throws ContextError', async () => {
    const mockOctokit = {};
    const mockPayload = {
      repository: { owner: { login: 'owner' } },
      pull_request: { number: 1 },
      sender: { login: 'user' },
    };

    await await expect(
      () => buildHandlerContext(mockPayload, mockOctokit, {}),
      (err) => err instanceof ContextError && err.field === 'repo'
    );
  });

  test('Missing pullNumber throws ContextError', async () => {
    const mockOctokit = {};
    const mockPayload = {
      repository: { owner: { login: 'owner' }, name: 'repo' },
      sender: { login: 'user' },
    };

    await await expect(
      () => buildHandlerContext(mockPayload, mockOctokit, {}),
      (err) => err instanceof ContextError && err.field === 'pullNumber'
    );
  });

  test('Missing sender throws ContextError', async () => {
    const mockOctokit = {};
    const mockPayload = {
      repository: { owner: { login: 'owner' }, name: 'repo' },
      pull_request: { number: 1 },
    };

    await await expect(
      () => buildHandlerContext(mockPayload, mockOctokit, {}),
      (err) => err instanceof ContextError && err.field === 'sender'
    );
  });
});
