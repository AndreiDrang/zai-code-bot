const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { buildSuggestPrompt, formatSuggestionsResponse } = require('../../src/lib/handlers/suggest');

describe('suggest handler', () => {
  describe('buildSuggestPrompt', () => {
    test('should build prompt with user guidance and diffs', () => {
      const files = [
        { filename: 'src/index.js', status: 'modified', patch: '+const x = 1;\n-const x = 0;' },
        { filename: 'src/utils.js', status: 'added', patch: '+export function add(a, b) {\n+  return a + b;\n+}' },
      ];
      const userPrompt = 'suggest better variable naming';

      const prompt = buildSuggestPrompt(files, userPrompt);

      assert.ok(prompt.includes('suggest better variable naming'));
      assert.ok(prompt.includes('src/index.js'));
      assert.ok(prompt.includes('src/utils.js'));
      assert.ok(prompt.includes('```diff'));
    });

    test('should filter files without patches', () => {
      const files = [
        { filename: 'src/index.js', status: 'modified', patch: null },
        { filename: 'src/utils.js', status: 'added', patch: '+const x = 1;' },
      ];
      const userPrompt = 'find bugs';

      const prompt = buildSuggestPrompt(files, userPrompt);

      assert.ok(prompt.includes('src/utils.js'));
      assert.ok(!prompt.includes('src/index.js'));
    });

    test('should handle empty files array', () => {
      const files = [];
      const userPrompt = 'review changes';

      const prompt = buildSuggestPrompt(files, userPrompt);

      assert.ok(prompt.includes('review changes'));
      assert.ok(prompt.includes('## Changed Files:'));
    });
  });

  describe('formatSuggestionsResponse', () => {
    test('should wrap plain text in header', () => {
      const suggestions = 'Consider renaming variable x to count.';
      const formatted = formatSuggestionsResponse(suggestions);

      assert.ok(formatted.includes('## Suggested Improvements'));
      assert.ok(formatted.includes('Consider renaming variable x to count.'));
    });

    test('should preserve code blocks if already present', () => {
      const suggestions = '```javascript\nconst newName = 1;\n```';
      const formatted = formatSuggestionsResponse(suggestions);

      assert.ok(formatted.includes('## Suggested Improvements'));
      assert.ok(formatted.includes('```javascript'));
    });

    test('should handle empty string', () => {
      const suggestions = '';
      const formatted = formatSuggestionsResponse(suggestions);

      assert.ok(formatted.includes('## Suggested Improvements'));
    });
  });
});
