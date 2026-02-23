const { test, describe } = require('node:test');
const assert = require('node:assert');
const { 
  parseLineRange, 
  buildExplainPrompt 
} = require('./explain');

describe('explain.js - parseLineRange', () => {
  test('returns error when no arg provided', () => {
    const result = parseLineRange(null);
    assert.strictEqual(result.startLine, null);
    assert.strictEqual(result.endLine, null);
    assert.ok(result.error.includes('No line range'));
  });

  test('returns error when arg is empty string', () => {
    const result = parseLineRange('');
    assert.strictEqual(result.startLine, null);
    assert.strictEqual(result.endLine, null);
    assert.ok(result.error.includes('No line range'));
  });

  test('parses hyphen format 10-15', () => {
    const result = parseLineRange('10-15');
    assert.strictEqual(result.startLine, 10);
    assert.strictEqual(result.endLine, 15);
    assert.strictEqual(result.error, undefined);
  });

  test('parses colon format 10:15', () => {
    const result = parseLineRange('10:15');
    assert.strictEqual(result.startLine, 10);
    assert.strictEqual(result.endLine, 15);
  });

  test('parses dot format 10..15', () => {
    const result = parseLineRange('10..15');
    assert.strictEqual(result.startLine, 10);
    assert.strictEqual(result.endLine, 15);
  });

  test('returns error for invalid format', () => {
    const result = parseLineRange('invalid');
    assert.strictEqual(result.startLine, null);
    assert.strictEqual(result.endLine, null);
    assert.ok(result.error.includes('Invalid line range format'));
  });

  test('returns error when start line < 1', () => {
    const result = parseLineRange('0-5');
    assert.strictEqual(result.startLine, null);
    assert.ok(result.error.includes('Start line must be >= 1'));
  });

  test('returns error when start > end', () => {
    const result = parseLineRange('15-10');
    assert.strictEqual(result.startLine, null);
    assert.ok(result.error.includes('cannot exceed'));
  });

  test('handles single line range 5-5', () => {
    const result = parseLineRange('5-5');
    assert.strictEqual(result.startLine, 5);
    assert.strictEqual(result.endLine, 5);
  });

  test('handles large line numbers', () => {
    const result = parseLineRange('1000-1500');
    assert.strictEqual(result.startLine, 1000);
    assert.strictEqual(result.endLine, 1500);
  });
});

describe('explain.js - buildExplainPrompt', () => {
  test('builds prompt with code content', () => {
    const lines = ['function test() {', '  return true;', '}'];
    const result = buildExplainPrompt('src/test.js', lines, 5, 7, 10000);
    
    assert.ok(result.prompt.includes('src/test.js'));
    assert.ok(result.prompt.includes('5-7'));
    assert.ok(result.prompt.includes('function test()'));
    assert.strictEqual(result.truncated, false);
  });

  test('wraps code in markdown code blocks', () => {
    const lines = ['const x = 1;'];
    const result = buildExplainPrompt('app.js', lines, 1, 1, 10000);
    
    assert.ok(result.prompt.includes('```'));
    assert.ok(result.prompt.includes('const x = 1;'));
  });

  test('respects maxChars and truncates', () => {
    const lines = ['line ' + 'a'.repeat(1000)];
    const result = buildExplainPrompt('app.js', lines, 1, 1, 100);
    
    assert.ok(result.truncated, true);
    assert.ok(result.prompt.includes('[truncated'));
  });

  test('includes line numbers in prompt', () => {
    const lines = ['code'];
    const result = buildExplainPrompt('app.js', lines, 10, 10, 10000);
    
    assert.ok(result.prompt.includes('Lines 10-10'));
  });
});
