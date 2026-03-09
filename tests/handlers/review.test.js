import { test, describe, expect } from 'vitest';
const { 
  parseFilePath, 
  validateFileInPr, 
  buildReviewPrompt,
  handleReviewCommand
} = require('../../src/lib/handlers/review');

describe('review.js - parseFilePath', () => {
  test('returns error when no args provided', () => {
    const result = parseFilePath([]);
    expect(result.filePath).toBe(null);
    expect(result.error.includes('No file path provided')).toBe(true);
  });

  test('returns error when args is null', () => {
    const result = parseFilePath(null);
    expect(result.filePath).toBe(null);
    expect(result.error.includes('No file path provided')).toBe(true);
  });

  test('returns file path when valid', () => {
    const result = parseFilePath(['src', 'index.js']);
    expect(result.filePath).toBe('src/index.js');
    expect(result.error).toBe(undefined);
  });

  test('returns error for path traversal attempt', () => {
    const result = parseFilePath(['..', 'etc', 'passwd']);
    expect(result.filePath).toBe(null);
    expect(result.error.includes('Path traversal')).toBe(true);
  });

  test('returns error for absolute path', () => {
    const result = parseFilePath(['/etc/passwd']);
    expect(result.filePath).toBe(null);
    expect(result.error.includes('Path traversal')).toBe(true);
  });

  test('handles single file argument', () => {
    const result = parseFilePath(['app.js']);
    expect(result.filePath).toBe('app.js');
  });
});

describe('review.js - validateFileInPr', () => {
  const mockChangedFiles = [
    { filename: 'src/index.js', status: 'modified', patch: '...' },
    { filename: 'src/lib/utils.js', status: 'added', patch: '...' },
    { filename: 'README.md', status: 'modified', patch: null },
  ];

  test('returns error when changedFiles is null', () => {
    const result = validateFileInPr('src/index.js', null);
    expect(result.valid).toBe(false);
    expect(result.error.includes('Unable to get')).toBe(true);
  });

  test('returns error when changedFiles is not array', () => {
    const result = validateFileInPr('src/index.js', 'not-an-array');
    expect(result.valid).toBe(false);
  });

  test('returns error when file not in PR', () => {
    const result = validateFileInPr('nonexistent.js', mockChangedFiles);
    expect(result.valid).toBe(false);
    expect(result.error.includes('not found in PR')).toBe(true);
  });

  test('returns valid when file found by exact match', () => {
    const result = validateFileInPr('src/index.js', mockChangedFiles);
    expect(result.valid).toBe(true);
    expect(result.file.filename).toBe('src/index.js');
  });

  test('returns valid when file found by basename', () => {
    const result = validateFileInPr('index.js', mockChangedFiles);
    expect(result.valid).toBe(true);
    expect(result.file.filename).toBe('src/index.js');
  });

  test('returns valid when file is case insensitive', () => {
    const result = validateFileInPr('SRC/INDEX.JS', mockChangedFiles);
    expect(result.valid).toBe(true);
    expect(result.file.filename).toBe('src/index.js');
  });

  test('returns file object with all properties', () => {
    const result = validateFileInPr('src/index.js', mockChangedFiles);
    expect(result.file.status).toBe('modified');
    expect(result.file.patch).toBe('...');
  });
});

describe('review.js - buildReviewPrompt', () => {
  test('builds prompt with diff content', () => {
    const filePath = 'src/index.js';
    const fullContent = '// existing content\nline 2';
    const patch = '@@ -1,3 +1,4 @@\n+new line\n old line';
    
    const result = buildReviewPrompt(filePath, fullContent, patch, 10000);
    
    expect(result.prompt.includes('<file_path>src/index.js</file_path>')).toBe(true);
    expect(result.prompt.includes('<full_code>')).toBe(true);
    expect(result.prompt.includes('<changes_in_this_pr>')).toBe(true);
    expect(result.prompt.includes('+new line')).toBe(true);
    expect(result.truncated).toBe(false);
  });

  test('handles file without patch', () => {
    const filePath = 'README.md';
    const fullContent = '# My Project';
    const patch = null;
    
    const result = buildReviewPrompt(filePath, fullContent, patch, 10000);
    
    expect(result.prompt.includes('No diff available')).toBe(true);
    expect(result.prompt.includes('<full_code>')).toBe(true);
    expect(result.prompt.includes('<changes_in_this_pr>')).toBe(true);
  });

  test('handles missing full content gracefully', () => {
    const filePath = 'src/index.js';
    const fullContent = null;
    const patch = '@@ -1,3 +1,4 @@\n+new line';
    
    const result = buildReviewPrompt(filePath, fullContent, patch, 10000);
    
    expect(result.prompt.includes('Full file content unavailable')).toBe(true);
    expect(result.prompt.includes('<changes_in_this_pr>')).toBe(true);
  });

  test('respects maxChars and truncates', () => {
    const filePath = 'src/index.js';
    const fullContent = 'a'.repeat(3000);
    const patch = 'b'.repeat(5000);
    
    const result = buildReviewPrompt(filePath, fullContent, patch, 100);
    
    expect(result.truncated, true).toBeTruthy();
    expect(result.prompt.includes('[truncated')).toBe(true);
  });
});

describe('review.js - handleReviewCommand', () => {
  test('returns error when parseFilePath fails', async () => {
    let commentPosted = false;
    let reactionPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => { reactionPosted = true; },
      fetchFileAtPrHead: async () => ({ success: true, data: 'content' }),
      createLogger: () => ({ info: () => {}, error: () => {} }),
      generateCorrelationId: () => 'test-id',
    };
    
    const context = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      changedFiles: [],
      apiClient: { call: async () => ({}) },
      apiKey: 'test-key',
      model: 'test-model',
      commentId: 999,
      pullNumber: 1,
    };
    
    const result = await handleReviewCommand(context, [], mockDeps);
    
    expect(result.success).toBe(false);
    expect(result.error.includes('No file path provided')).toBe(true);
    expect(commentPosted).toBeTruthy();
    expect(reactionPosted).toBeTruthy();
  });

  test('returns error when validateFileInPr fails', async () => {
    let commentPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({ success: true, data: 'content' }),
      createLogger: () => ({ info: () => {}, error: () => {} }),
      generateCorrelationId: () => 'test-id',
    };
    
    const changedFiles = [
      { filename: 'src/index.js', status: 'modified', patch: '...' }
    ];
    
    const context = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      changedFiles,
      apiClient: { call: async () => ({}) },
      apiKey: 'test-key',
      model: 'test-model',
      commentId: null,
      pullNumber: 1,
    };
    
    const result = await handleReviewCommand(context, ['nonexistent.js'], mockDeps);
    
    expect(result.success).toBe(false);
    expect(result.error.includes('not found in PR')).toBe(true);
    expect(commentPosted).toBeTruthy();
  });

  test('calls API and posts review on success', async () => {
    let commentPosted = false;
    let reactionPosted = false;
    let apiCalled = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => { reactionPosted = true; },
      fetchFileAtPrHead: async () => ({ success: true, data: 'file content' }),
      createLogger: () => ({ info: () => {}, error: () => {} }),
      generateCorrelationId: () => 'test-id',
    };
    
    const changedFiles = [
      { filename: 'src/index.js', status: 'modified', patch: '@@ -1,2 +1,3 @@\n+new line' }
    ];
    
    const context = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      changedFiles,
      apiClient: { 
        call: async () => { 
          apiCalled = true;
          return { success: true, data: 'Great code review!' }; 
        } 
      },
      apiKey: 'test-key',
      model: 'test-model',
      commentId: 999,
      pullNumber: 1,
    };
    
    const result = await handleReviewCommand(context, ['src/index.js'], mockDeps);
    
    expect(result.success).toBe(true);
    expect(apiCalled).toBeTruthy();
    expect(commentPosted).toBeTruthy();
    expect(reactionPosted).toBeTruthy();
  });

  test('handles API failure gracefully', async () => {
    let commentPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({ success: true, data: 'file content' }),
      createLogger: () => ({ info: () => {}, error: () => {} }),
      generateCorrelationId: () => 'test-id',
    };
    
    const changedFiles = [
      { filename: 'src/index.js', status: 'modified', patch: '@@ -1,2 +1,3 @@\n+new line' }
    ];
    
    const context = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      changedFiles,
      apiClient: { 
        call: async () => ({ 
          success: false, 
          error: { message: 'Rate limit exceeded' } 
        }) 
      },
      apiKey: 'test-key',
      model: 'test-model',
      commentId: null,
      pullNumber: 1,
    };
    
    const result = await handleReviewCommand(context, ['src/index.js'], mockDeps);
    
    expect(result.success).toBe(false);
    expect(result.error.includes('Rate limit exceeded')).toBe(true);
    expect(commentPosted).toBeTruthy();
  });

  test('handles exception in try/catch block', async () => {
    let errorCommentPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { errorCommentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({ success: true, data: 'file content' }),
      createLogger: () => ({ info: () => {}, error: () => {} }),
      generateCorrelationId: () => 'test-id',
    };
    
    const changedFiles = [
      { filename: 'src/index.js', status: 'modified', patch: '@@ -1,2 +1,3 @@\n+new line' }
    ];
    
    const context = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      changedFiles,
      apiClient: { 
        call: async () => { throw new Error('Unexpected error'); }
      },
      apiKey: 'test-key',
      model: 'test-model',
      commentId: null,
      pullNumber: 1,
    };
    
    const result = await handleReviewCommand(context, ['src/index.js'], mockDeps);
    
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(errorCommentPosted).toBeTruthy();
  });

  test('uses fallback when fullContent fetch fails', async () => {
    let apiCalled = false;
    
    const mockDeps = {
      upsertComment: async () => ({ data: { id: 123 } }),
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({ success: false, error: 'File too large' }),
      createLogger: () => ({ info: () => {}, error: () => {} }),
      generateCorrelationId: () => 'test-id',
    };
    
    const changedFiles = [
      { filename: 'src/index.js', status: 'modified', patch: '@@ -1,2 +1,3 @@\n+new line' }
    ];
    
    const context = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      changedFiles,
      apiClient: { 
        call: async (params) => { 
          apiCalled = true;
          expect(params.prompt.includes('Full file content unavailable')).toBe(true);
          return { success: true, data: 'Review complete' }; 
        } 
      },
      apiKey: 'test-key',
      model: 'test-model',
      commentId: null,
      pullNumber: 1,
    };
    
    const result = await handleReviewCommand(context, ['src/index.js'], mockDeps);
    
    expect(result.success).toBe(true);
    expect(apiCalled).toBeTruthy();
  });
});
