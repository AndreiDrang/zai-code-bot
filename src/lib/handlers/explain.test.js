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
  test('builds prompt with surrounding scope and target lines', () => {
    const scopeResult = {
      target: ['function test() {', '  return true;', '}'],
      surrounding: ['// comment', 'function test() {', '  return true;', '}', '// end']
    };
    const result = buildExplainPrompt('src/test.js', scopeResult, 5, 7, 10000);
    
    assert.ok(result.prompt.includes('<surrounding_scope>'), 'should include surrounding_scope tag');
    assert.ok(result.prompt.includes('<target_lines>5-7</target_lines>'), 'should include target_lines tag with range');
    assert.ok(result.prompt.includes('<code>'), 'should include code tag');
    assert.ok(result.prompt.includes('function test()'), 'should include code content');
    assert.strictEqual(result.truncated, false);
  });

  test('includes target_lines and code tags', () => {
    const scopeResult = {
      target: ['const x = 1;'],
      surrounding: ['const x = 1;']
    };
    const result = buildExplainPrompt('app.js', scopeResult, 1, 1, 10000);
    
    assert.ok(result.prompt.includes('<target_lines>1-1</target_lines>'));
    assert.ok(result.prompt.includes('<code>'));
    assert.ok(result.prompt.includes('const x = 1;'));
  });

  test('respects maxChars and truncates', () => {
    const longLine = 'line ' + 'a'.repeat(1000);
    const scopeResult = {
      target: [longLine],
      surrounding: [longLine]
    };
    const result = buildExplainPrompt('app.js', scopeResult, 1, 1, 100);
    
    assert.ok(result.truncated, true);
    assert.ok(result.prompt.includes('[truncated'));
  });

  test('includes target line range in target_lines tag', () => {
    const scopeResult = {
      target: ['code'],
      surrounding: ['code']
    };
    const result = buildExplainPrompt('app.js', scopeResult, 10, 10, 10000);
    
    assert.ok(result.prompt.includes('<target_lines>10-10</target_lines>'));
  });

  test('handles legacy array format for backward compatibility', () => {
    const lines = ['function test() {', '  return true;', '}'];
    const result = buildExplainPrompt('src/test.js', lines, 5, 7, 10000);
    
    assert.ok(result.prompt.includes('function test()'));
    assert.strictEqual(result.truncated, false);
  });
});
