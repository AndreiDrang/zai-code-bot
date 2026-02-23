const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { buildSuggestPrompt, formatSuggestionsResponse, resolveAnchor, parseFileLineAnchor } = require('../../src/lib/handlers/suggest');

describe('suggest handler', () => {
  describe('parseFileLineAnchor', () => {
    test('parses file:line format', () => {
      const result = parseFileLineAnchor('src/lib/auth.js:42 suggest better handling');
      assert.strictEqual(result.path, 'src/lib/auth.js');
      assert.strictEqual(result.line, 42);
    });

    test('returns null for no pattern', () => {
      const result = parseFileLineAnchor('just some text');
      assert.strictEqual(result.path, null);
      assert.strictEqual(result.line, null);
    });

    test('returns null for invalid line', () => {
      const result = parseFileLineAnchor('file.js:abc');
      assert.strictEqual(result.path, null);
      assert.strictEqual(result.line, null);
    });
  });

  describe('resolveAnchor', () => {
    test('resolves from comment metadata when available', () => {
      const context = { commentPath: 'src/index.js', commentLine: 25 };
      const result = resolveAnchor(context, 'some instruction');
      assert.strictEqual(result.path, 'src/index.js');
      assert.strictEqual(result.line, 25);
      assert.strictEqual(result.source, 'comment_metadata');
    });

    test('falls back to instruction parse when no comment metadata', () => {
      const context = { commentPath: null, commentLine: null };
      const result = resolveAnchor(context, 'src/utils.js:100 improve this');
      assert.strictEqual(result.path, 'src/utils.js');
      assert.strictEqual(result.line, 100);
      assert.strictEqual(result.source, 'instruction_parse');
    });

    test('returns none when no anchor available', () => {
      const context = { commentPath: null, commentLine: null };
      const result = resolveAnchor(context, 'make this better');
      assert.strictEqual(result.path, null);
      assert.strictEqual(result.line, null);
      assert.strictEqual(result.source, 'none');
    });
  });

  describe('buildSuggestPrompt', () => {
    test('builds prompt with file and code block', () => {
      const path = 'src/utils.js';
      const blockResult = {
        target: ['function add(a, b) {', '  return a + b;', '}'],
        fallback: false,
        note: undefined
      };
      const userInstruction = 'add type hints';

      const result = buildSuggestPrompt(path, blockResult, userInstruction);

      assert.ok(result.prompt.includes('<file>src/utils.js</file>'));
      assert.ok(result.prompt.includes('<code>'));
      assert.ok(result.prompt.includes('function add(a, b) {'));
      assert.ok(result.prompt.includes('User Instruction: add type hints'));
    });

    test('includes fallback note when block fallback is true', () => {
      const path = 'src/utils.js';
      const blockResult = {
        target: ['line 1', 'line 2'],
        fallback: true,
        note: 'Could not determine block'
      };
      const userInstruction = 'improve this';

      const result = buildSuggestPrompt(path, blockResult, userInstruction);

      assert.ok(result.prompt.includes('_(Note:'));
      assert.ok(result.prompt.includes('Could not determine block'));
    });

    test('respects maxChars and truncates', () => {
      const path = 'src/utils.js';
      const blockResult = {
        target: Array(100).fill('function test() { return 1; }'),
        fallback: false
      };
      const userInstruction = 'test';

      const result = buildSuggestPrompt(path, blockResult, userInstruction, 500);

      assert.ok(result.truncated);
      assert.ok(result.prompt.length <= 500 + 100); // Allow for marker overhead
    });
  });

  describe('formatSuggestionsResponse', () => {
    test('wraps plain text in header', () => {
      const suggestions = 'Consider renaming variable x to count.';
      const formatted = formatSuggestionsResponse(suggestions);

      assert.ok(formatted.includes('## Suggested Improvements'));
      assert.ok(formatted.includes('Consider renaming variable x to count.'));
    });

    test('preserves code blocks if already present', () => {
      const suggestions = '```javascript\nconst newName = 1;\n```';
      const formatted = formatSuggestionsResponse(suggestions);

      assert.ok(formatted.includes('## Suggested Improvements'));
      assert.ok(formatted.includes('```javascript'));
    });

    test('handles empty string', () => {
      const suggestions = '';
      const formatted = formatSuggestionsResponse(suggestions);

      assert.ok(formatted.includes('## Suggested Improvements'));
    });
  });
});
