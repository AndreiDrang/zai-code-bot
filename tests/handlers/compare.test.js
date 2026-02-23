const { test, describe } = require('node:test');
const assert = require('node:assert');
const { buildComparePrompt, formatCompareResponse } = require('../../src/lib/handlers/compare');

describe('compare handler', () => {
  describe('buildComparePrompt', () => {
    test('should build prompt for old vs new comparison', () => {
      const files = [
        { filename: 'src/index.js', status: 'modified', patch: '+const newVal = 1;\n-const oldVal = 0;' },
        { filename: 'src/utils.js', status: 'modified', patch: '+function updated() {}\n-function old() {}' },
      ];

      const prompt = buildComparePrompt(files);

      assert.ok(prompt.includes('Compare the OLD version with the NEW version'));
      assert.ok(prompt.includes('src/index.js'));
      assert.ok(prompt.includes('src/utils.js'));
      assert.ok(prompt.includes('```diff'));
      assert.ok(prompt.includes('1. What changed between old and new versions'));
      assert.ok(prompt.includes('2. Key differences in approach'));
      assert.ok(prompt.includes('3. Potential implications'));
      assert.ok(prompt.includes('4. Any concerns'));
    });

    test('should filter files without patches', () => {
      const files = [
        { filename: 'README.md', status: 'modified', patch: null },
        { filename: 'src/app.js', status: 'added', patch: '+const x = 1;' },
      ];

      const prompt = buildComparePrompt(files);

      assert.ok(prompt.includes('src/app.js'));
      assert.ok(!prompt.includes('README.md'));
    });

    test('should handle empty files array', () => {
      const files = [];

      const prompt = buildComparePrompt(files);

      assert.ok(prompt.includes('## Changed Files:'));
      assert.ok(prompt.includes('Compare the OLD version'));
    });
  });

  describe('formatCompareResponse', () => {
    test('should wrap plain text in comparison header', () => {
      const comparison = 'The variable was renamed from x to count.';
      const formatted = formatCompareResponse(comparison);

      assert.ok(formatted.includes('## Old vs New Comparison'));
      assert.ok(formatted.includes('The variable was renamed from x to count.'));
    });

    test('should preserve code blocks if present', () => {
      const comparison = '```diff\n-old\n+new\n```';
      const formatted = formatCompareResponse(comparison);

      assert.ok(formatted.includes('## Old vs New Comparison'));
      assert.ok(formatted.includes('```diff'));
    });

    test('should handle empty string', () => {
      const comparison = '';
      const formatted = formatCompareResponse(comparison);

      assert.ok(formatted.includes('## Old vs New Comparison'));
    });
  });
});
