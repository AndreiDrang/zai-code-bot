const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  truncateContext,
  extractLines,
  validateRange,
  getDefaultMaxChars,
  DEFAULT_MAX_CHARS
} = require('../src/lib/context');

describe('truncateContext', () => {
  test('returns original content when under maxChars', () => {
    const content = 'short content';
    const result = truncateContext(content, 100);
    assert.strictEqual(result.content, content);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.omitted, 0);
  });

  test('truncates content and adds marker when over maxChars', () => {
    const content = 'a'.repeat(1000);
    const result = truncateContext(content, 100);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.content.includes('[truncated,'));
    assert.ok(result.content.includes('chars omitted]'));
    assert.ok(result.content.length > 50);
    assert.ok(result.omitted > 0);
    assert.ok(result.content.length <= 100);
  });

  test('uses default maxChars of 8000', () => {
    const content = 'a'.repeat(10000);
    const result = truncateContext(content);
    assert.strictEqual(result.truncated, true);
    assert.strictEqual(DEFAULT_MAX_CHARS, 8000);
  });

  test('throws TypeError for non-string content', () => {
    assert.throws(() => truncateContext(123), TypeError);
    assert.throws(() => truncateContext(null), TypeError);
  });

  test('throws TypeError for invalid maxChars', () => {
    assert.throws(() => truncateContext('test', 0), TypeError);
    assert.throws(() => truncateContext('test', -1), TypeError);
    assert.throws(() => truncateContext('test', 'abc'), TypeError);
  });

  test('handles edge case when maxChars is smaller than marker', () => {
    const content = 'hello world';
    const result = truncateContext(content, 5);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.content.includes('[truncated,'));
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
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.lines, ['line2', 'line3', 'line4']);
  });

  test('extracts single line', () => {
    const result = extractLines(sampleContent, 3, 3);
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.lines, ['line3']);
  });

  test('extracts full range', () => {
    const result = extractLines(sampleContent, 1, 5);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.lines.length, 5);
  });

  test('returns error for start > end', () => {
    const result = extractLines(sampleContent, 4, 2);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('cannot exceed'));
  });

  test('returns error for start < 1', () => {
    const result = extractLines(sampleContent, 0, 3);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('must be >= 1'));
  });

  test('returns error for end > maxLines', () => {
    const result = extractLines(sampleContent, 1, 10);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('exceeds content'));
  });

  test('throws TypeError for non-string content', () => {
    assert.throws(() => extractLines(123, 1, 3), TypeError);
  });
});

describe('validateRange', () => {
  test('returns valid for correct range', () => {
    const result = validateRange(1, 10, 10);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.error, undefined);
  });

  test('returns error for non-number parameters', () => {
    const result = validateRange('1', 10, 10);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('must be numbers'));
  });

  test('returns error for non-integer parameters', () => {
    const result = validateRange(1.5, 10, 10);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('integers'));
  });

  test('returns error for startLine < 1', () => {
    const result = validateRange(0, 5, 10);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('must be >= 1'));
  });

  test('returns error for endLine > maxLines', () => {
    const result = validateRange(1, 15, 10);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('exceeds content'));
  });

  test('returns error for startLine > endLine', () => {
    const result = validateRange(8, 5, 10);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('cannot exceed'));
  });
});

describe('getDefaultMaxChars', () => {
  test('returns 8000', () => {
    assert.strictEqual(getDefaultMaxChars(), 8000);
  });
});
