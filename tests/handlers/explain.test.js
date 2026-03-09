import { test, describe, expect } from 'vitest';
const explainModule = require('../../src/lib/handlers/explain');
const { parseLineRange, buildExplainPrompt } = explainModule;

describe('explain.js - parseLineRange', () => {
  test('returns error when no arg provided', () => {
    const result = parseLineRange(null);
    expect(result.startLine).toBe(null);
    expect(result.endLine).toBe(null);
    expect(result.error.includes('No line range')).toBe(true);
  });

  test('returns error when arg is empty string', () => {
    const result = parseLineRange('');
    expect(result.startLine).toBe(null);
    expect(result.endLine).toBe(null);
    expect(result.error.includes('No line range')).toBe(true);
  });

  test('parses hyphen format 10-15', () => {
    const result = parseLineRange('10-15');
    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(15);
    expect(result.error).toBe(undefined);
  });

  test('parses colon format 10:15', () => {
    const result = parseLineRange('10:15');
    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(15);
  });

  test('parses dot format 10..15', () => {
    const result = parseLineRange('10..15');
    expect(result.startLine).toBe(10);
    expect(result.endLine).toBe(15);
  });

  test('returns error for invalid format', () => {
    const result = parseLineRange('invalid');
    expect(result.startLine).toBe(null);
    expect(result.endLine).toBe(null);
    expect(result.error.includes('Invalid line range format')).toBe(true);
  });

  test('returns error when start line < 1', () => {
    const result = parseLineRange('0-5');
    expect(result.startLine).toBe(null);
    expect(result.error.includes('Start line must be >= 1')).toBe(true);
  });

  test('returns error when start > end', () => {
    const result = parseLineRange('15-10');
    expect(result.startLine).toBe(null);
    expect(result.error.includes('cannot exceed')).toBe(true);
  });

  test('handles single line range 5-5', () => {
    const result = parseLineRange('5-5');
    expect(result.startLine).toBe(5);
    expect(result.endLine).toBe(5);
  });

  test('handles large line numbers', () => {
    const result = parseLineRange('1000-1500');
    expect(result.startLine).toBe(1000);
    expect(result.endLine).toBe(1500);
  });
});

describe('explain.js - buildExplainPrompt', () => {
  test('builds prompt with surrounding scope and target lines', () => {
    const scopeResult = {
      target: ['function test() {', '  return true;', '}'],
      surrounding: ['// comment', 'function test() {', '  return true;', '}', '// end']
    };
    const result = buildExplainPrompt('src/test.js', scopeResult, 5, 7, 10000);
    
    expect(result.prompt).toContain('<surrounding_scope>');
    expect(result.prompt).toContain('<target_lines>5-7</target_lines>');
    expect(result.prompt).toContain('<code>');
    expect(result.prompt).toContain('function test()');
    expect(result.truncated).toBe(false);
  });

  test('includes target_lines and code tags', () => {
    const scopeResult = {
      target: ['const x = 1;'],
      surrounding: ['const x = 1;']
    };
    const result = buildExplainPrompt('app.js', scopeResult, 1, 1, 10000);
    
    expect(result.prompt).toContain('<target_lines>1-1</target_lines>');
    expect(result.prompt).toContain('<code>');
    expect(result.prompt).toContain('const x = 1;');
  });

  test('respects maxChars and truncates', () => {
    const longLine = 'line ' + 'a'.repeat(1000);
    const scopeResult = {
      target: [longLine],
      surrounding: [longLine]
    };
    const result = buildExplainPrompt('app.js', scopeResult, 1, 1, 100);
    
    expect(result.truncated).toBe(true);
    expect(result.prompt).toContain('[truncated');
  });

  test('includes target line range in target_lines tag', () => {
    const scopeResult = {
      target: ['code'],
      surrounding: ['code']
    };
    const result = buildExplainPrompt('app.js', scopeResult, 10, 10, 10000);
    
    expect(result.prompt).toContain('<target_lines>10-10</target_lines>');
  });

  test('handles legacy array format for backward compatibility', () => {
    const lines = ['function test() {', '  return true;', '}'];
    const result = buildExplainPrompt('src/test.js', lines, 5, 7, 10000);
    
    expect(result.prompt).toContain('function test()');
    expect(result.truncated).toBe(false);
  });
});

describe('explain.js - handleExplainCommand', () => {
  test('returns error when no args provided', async () => {
    let commentPosted = false;
    let reactionPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => { reactionPosted = true; },
      fetchFileAtPrHead: async () => ({ success: true, data: 'content', lineCount: 10 }),
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: { call: async () => ({}) },
      apiKey: 'test-key',
      model: 'test-model',
      filename: 'test.js',
      changedFiles: [{ filename: 'test.js' }]
    };

    const result = await explainModule.handleExplainCommand(mockContext, [], mockDeps);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No line range provided');
    expect(commentPosted).toBeTruthy();
    expect(reactionPosted).toBeTruthy();
  });

  test('returns error when parseLineRange fails', async () => {
    let commentPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({ success: true, data: 'content', lineCount: 10 }),
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: { call: async () => ({}) },
      apiKey: 'test-key',
      model: 'test-model',
      filename: 'test.js',
      changedFiles: [{ filename: 'test.js' }]
    };

    const result = await explainModule.handleExplainCommand(mockContext, ['invalid'], mockDeps);

    expect(result.success).toBe(false);
    expect(result.error.includes('Invalid line range format')).toBe(true);
    expect(commentPosted).toBeTruthy();
  });

  test('returns error when no target file specified', async () => {
    let commentPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({ success: true, data: 'content', lineCount: 10 }),
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: { call: async () => ({}) },
      apiKey: 'test-key',
      model: 'test-model',
      filename: null,
      changedFiles: []
    };

    const result = await explainModule.handleExplainCommand(mockContext, ['10-15'], mockDeps);

    expect(result.success).toBe(false);
    expect(result.error).toBe('No target file specified');
    expect(commentPosted).toBeTruthy();
  });

  test('returns error when file fetch fails', async () => {
    let commentPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({ success: false, fallback: 'File not found' }),
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: { call: async () => ({}) },
      apiKey: 'test-key',
      model: 'test-model',
      filename: 'test.js',
      changedFiles: []
    };

    const result = await explainModule.handleExplainCommand(mockContext, ['10-15'], mockDeps);

    expect(result.success).toBe(false);
    expect(result.error).toBe('File not found');
    expect(commentPosted).toBeTruthy();
  });

  test('returns error when line range validation fails', async () => {
    let commentPosted = false;
    
    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({
        success: true,
        data: 'line1\nline2\nline3\nline4\nline5',
        lineCount: 5
      }),
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: false, error: 'Line 10 exceeds file length' }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: { call: async () => ({}) },
      apiKey: 'test-key',
      model: 'test-model',
      filename: 'test.js',
      changedFiles: []
    };

    const result = await explainModule.handleExplainCommand(mockContext, ['10-15'], mockDeps);

    expect(result.success).toBe(false);
    expect(result.error.includes('exceeds')).toBe(true);
    expect(commentPosted).toBeTruthy();
  });

  test('calls API and posts explanation on success', async () => {
    let commentPosted = false;
    let reactionPosted = false;
    let apiCalled = false;

    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => { reactionPosted = true; },
      fetchFileAtPrHead: async () => ({
        success: true,
        data: 'function test() {\n  return true;\n}',
        lineCount: 3,
        scoped: false
      }),
      extractWindow: () => ({ 
        target: ['function test() {', '  return true;'], 
        surrounding: ['function test() {', '  return true;', '}'], 
        fallback: false 
      }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: { 
        call: async () => { 
          apiCalled = true;
          return { success: true, data: 'This function returns true.' }; 
        } 
      },
      apiKey: 'test-key',
      model: 'test-model',
      filename: 'test.js',
      changedFiles: []
    };

    const result = await explainModule.handleExplainCommand(mockContext, ['1-2'], mockDeps);

    expect(result.success).toBe(true);
    expect(apiCalled).toBeTruthy();
    expect(commentPosted).toBeTruthy();
    expect(reactionPosted).toBeTruthy();
  });

  test('handles API failure gracefully', async () => {
    let commentPosted = false;
    let reactionPosted = false;

    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => { reactionPosted = true; },
      fetchFileAtPrHead: async () => ({
        success: true,
        data: 'function test() {\n  return true;\n}',
        lineCount: 3,
        scoped: false
      }),
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: { 
        call: async () => ({ 
          success: false, 
          error: { message: 'API rate limit exceeded', attempts: 3, totalDuration: 5000 }
        }) 
      },
      apiKey: 'test-key',
      model: 'test-model',
      filename: 'test.js',
      changedFiles: []
    };

    const result = await explainModule.handleExplainCommand(mockContext, ['1-2'], mockDeps);

    expect(result.success).toBe(false);
    expect(result.error.includes('API rate limit exceeded')).toBe(true);
    expect(commentPosted).toBeTruthy();
    expect(reactionPosted).toBeTruthy();
  });

  test('handles exception in try/catch block', async () => {
    let commentPosted = false;

    const mockDeps = {
      upsertComment: async () => { commentPosted = true; return { data: { id: 123 } }; },
      setReaction: async () => {},
      fetchFileAtPrHead: async () => ({
        success: true,
        data: 'function test() {\n  return true;\n}',
        lineCount: 3,
        scoped: false
      }),
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      apiClient: { 
        call: async () => { throw new Error('Unexpected network error'); }
      },
      apiKey: 'test-key',
      model: 'test-model',
      filename: 'test.js',
      changedFiles: []
    };

    const result = await explainModule.handleExplainCommand(mockContext, ['1-2'], mockDeps);

    expect(result.success).toBe(false);
    expect(result.error.includes('Unexpected network error')).toBe(true);
    expect(commentPosted).toBeTruthy();
  });

  test('uses commentPath from context when available', async () => {
    let fetchCalledWith = null;

    const mockDeps = {
      upsertComment: async () => ({ data: { id: 123 } }),
      setReaction: async () => {},
      fetchFileAtPrHead: async (octokit, owner, repo, path) => {
        fetchCalledWith = path;
        return {
          success: true,
          data: 'function test() {\n  return true;\n}',
          lineCount: 3,
          scoped: false
        };
      },
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      commentPath: 'src/specific/file.js',
      apiClient: { call: async () => ({ success: true, data: 'Explanation' }) },
      apiKey: 'test-key',
      model: 'test-model',
      filename: 'test.js',
      changedFiles: []
    };

    await explainModule.handleExplainCommand(mockContext, ['1-2'], mockDeps);

    expect(fetchCalledWith).toBe('src/specific/file.js');
  });

  test('falls back to first changed file when no path specified', async () => {
    let fetchCalledWith = null;

    const mockDeps = {
      upsertComment: async () => ({ data: { id: 123 } }),
      setReaction: async () => {},
      fetchFileAtPrHead: async (octokit, owner, repo, path) => {
        fetchCalledWith = path;
        return {
          success: true,
          data: 'function test() {\n  return true;\n}',
          lineCount: 3,
          scoped: false
        };
      },
      extractWindow: () => ({ target: ['line'], surrounding: ['line'], fallback: false }),
      createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {} }),
      generateCorrelationId: () => 'test-id',
      validateRange: () => ({ valid: true }),
    };

    const mockContext = {
      octokit: {},
      owner: 'test-owner',
      repo: 'test-repo',
      issueNumber: 1,
      commentId: 100,
      commentPath: null,
      apiClient: { call: async () => ({ success: true, data: 'Explanation' }) },
      apiKey: 'test-key',
      model: 'test-model',
      filename: null,
      changedFiles: [
        { filename: 'first/changed/file.js' },
        { filename: 'second/changed/file.js' }
      ]
    };

    await explainModule.handleExplainCommand(mockContext, ['1-2'], mockDeps);

    expect(fetchCalledWith).toBe('first/changed/file.js');
  });
});
