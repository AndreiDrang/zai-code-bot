const { test, describe } = require('node:test');
const assert = require('node:assert');
const { buildComparePrompt, formatCompareResponse, MAX_COMPARE_FILES, MAX_FILE_CHARS } = require('../../src/lib/handlers/compare');

describe('compare handler', () => {
  describe('buildComparePrompt', () => {
    test('should build prompt for old vs new comparison', () => {
      const filesData = [
        { filename: 'src/index.js', status: 'modified', oldVersion: 'const oldVal = 0;', newVersion: 'const newVal = 1;' },
        { filename: 'src/utils.js', status: 'modified', oldVersion: 'function old() {}', newVersion: 'function updated() {}' },
      ];

      const prompt = buildComparePrompt(filesData, MAX_FILE_CHARS, 10);

      assert.ok(prompt.includes('Compare the OLD version with the NEW version'));
      assert.ok(prompt.includes('src/index.js'));
      assert.ok(prompt.includes('src/utils.js'));
      assert.ok(prompt.includes('<old_version>'));
      assert.ok(prompt.includes('<new_version>'));
      assert.ok(prompt.includes('const oldVal = 0;'));
      assert.ok(prompt.includes('const newVal = 1;'));
      assert.ok(prompt.includes('1. What changed between old and new versions'));
      assert.ok(prompt.includes('2. Key differences in approach'));
      assert.ok(prompt.includes('3. Potential implications'));
      assert.ok(prompt.includes('4. Any concerns'));
    });

    test('should handle new files and deleted files', () => {
      const filesData = [
        { filename: 'src/new.js', status: 'added', oldVersion: null, newVersion: 'const x = 1;' },
        { filename: 'src/deleted.js', status: 'removed', oldVersion: 'const y = 2;', newVersion: null },
      ];

      const prompt = buildComparePrompt(filesData, MAX_FILE_CHARS, 10);

      assert.ok(prompt.includes('[File did not exist in base branch]'));
      assert.ok(prompt.includes('[File was deleted in this PR]'));
      assert.ok(prompt.includes('src/new.js'));
      assert.ok(prompt.includes('src/deleted.js'));
    });

    test('should limit files to MAX_COMPARE_FILES and add note', () => {
      // Pass only MAX_COMPARE_FILES but indicate there are more total
      const filesData = Array.from({ length: MAX_COMPARE_FILES }, (_, i) => ({
        filename: `src/file${i}.js`,
        status: 'modified',
        oldVersion: `old${i}`,
        newVersion: `new${i}`,
      }));

      const prompt = buildComparePrompt(filesData, MAX_FILE_CHARS, 10);

      assert.ok(prompt.includes(`[Comparison limited to first ${MAX_COMPARE_FILES} of 10 changed files]`));
      assert.ok(prompt.includes('src/file0.js'));
      assert.ok(prompt.includes('src/file4.js'));
      assert.ok(!prompt.includes('src/file5.js'));
    });

    test('should handle empty files array', () => {
      const filesData = [];

      const prompt = buildComparePrompt(filesData, MAX_FILE_CHARS, 10);

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
