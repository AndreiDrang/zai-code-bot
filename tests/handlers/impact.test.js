const { test, describe } = require('node:test');
const assert = require('node:assert');
const { 
  buildImpactPrompt, 
  extractSuggestedLabels, 
  formatChangedFiles 
} = require('../../src/lib/handlers/impact');

describe('impact.js - formatChangedFiles', () => {
  test('returns "No files changed" when array is empty', () => {
    const result = formatChangedFiles([]);
    assert.strictEqual(result, 'No files changed');
  });

  test('returns "No files changed" when null', () => {
    const result = formatChangedFiles(null);
    assert.strictEqual(result, 'No files changed');
  });

  test('formats a single modified file with patch', () => {
    const files = [{
      filename: 'src/index.js',
      status: 'modified',
      patch: '@@ -1,3 +1,4 @@\n+new line\n old line'
    }];
    
    const result = formatChangedFiles(files);
    
    assert.ok(result.includes('`src/index.js`'));
    assert.ok(result.includes('(modified)'));
    assert.ok(result.includes('```diff'));
    assert.ok(result.includes('+new line'));
  });

  test('formats file without patch', () => {
    const files = [{
      filename: 'README.md',
      status: 'added',
      patch: null
    }];
    
    const result = formatChangedFiles(files);
    
    assert.ok(result.includes('`README.md`'));
    assert.ok(result.includes('(added)'));
    assert.ok(!result.includes('```diff'));
  });

  test('truncates long patches', () => {
    const longPatch = Array(60).fill('line content').join('\n');
    const files = [{
      filename: 'large.js',
      status: 'modified',
      patch: longPatch
    }];
    
    const result = formatChangedFiles(files);
    
    assert.ok(result.includes('[truncated'));
  });

  test('handles multiple files', () => {
    const files = [
      { filename: 'a.js', status: 'added', patch: null },
      { filename: 'b.js', status: 'removed', patch: null }
    ];
    
    const result = formatChangedFiles(files);
    
    assert.ok(result.includes('`a.js`'));
    assert.ok(result.includes('`b.js`'));
  });
});

describe('impact.js - buildImpactPrompt', () => {
  test('builds prompt with PR title and description', () => {
    const pr = { title: 'Add feature X', body: 'This PR adds feature X' };
    const files = [{ filename: 'src/x.js', status: 'added', patch: null }];
    
    const result = buildImpactPrompt(pr, files, 10000);
    
    assert.ok(result.prompt.includes('Add feature X'));
    assert.ok(result.prompt.includes('This PR adds feature X'));
    assert.ok(result.prompt.includes('src/x.js'));
    assert.strictEqual(result.truncated, false);
  });

  test('handles missing PR title', () => {
    const pr = { title: null, body: 'Body only' };
    const files = [];
    
    const result = buildImpactPrompt(pr, files, 10000);
    
    assert.ok(result.prompt.includes('No title provided'));
    assert.ok(result.prompt.includes('Body only'));
  });

  test('handles missing PR body', () => {
    const pr = { title: 'Title only', body: null };
    const files = [];
    
    const result = buildImpactPrompt(pr, files, 10000);
    
    assert.ok(result.prompt.includes('Title only'));
    assert.ok(result.prompt.includes('No description provided'));
  });

  test('respects maxChars and truncates', () => {
    const pr = { 
      title: 'Title', 
      body: 'x'.repeat(500) 
    };
    const files = [{ filename: 'test.js', status: 'modified', patch: 'y'.repeat(500) }];
    
    const result = buildImpactPrompt(pr, files, 100);
    
    assert.strictEqual(result.truncated, true);
  });
});

describe('impact.js - extractSuggestedLabels', () => {
  test('extracts backticked labels from response', () => {
    const response = `**Risk Level:** 🟡 Medium

**Impact Summary:**
This PR modifies authentication logic.

**Critical Areas Touched:**
* \`auth/middleware.js\`: Modified token validation

**Suggested Labels:**
\`risk: medium\`, \`area: auth\`, \`type: security\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: medium', 'area: auth', 'type: security']);
  });

  test('returns empty array for null response', () => {
    const labels = extractSuggestedLabels(null);
    assert.deepStrictEqual(labels, []);
  });

  test('returns empty array for empty string', () => {
    const labels = extractSuggestedLabels('');
    assert.deepStrictEqual(labels, []);
  });

  test('returns empty array when no labels section found', () => {
    const response = `**Risk Level:** 🟢 Low

**Impact Summary:**
Documentation changes only.`;

    const labels = extractSuggestedLabels(response);
    assert.deepStrictEqual(labels, []);
  });

  test('handles labels with spaces', () => {
    const response = `**Suggested Labels:**
\`risk: high\`, \`area: database\`, \`needs review\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: high', 'area: database', 'needs review']);
  });

  test('deduplicates labels', () => {
    const response = `**Suggested Labels:**
\`risk: medium\`, \`area: auth\`, \`risk: medium\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: medium', 'area: auth']);
  });

  test('limits to 5 labels', () => {
    const response = `**Suggested Labels:**
\`label1\`, \`label2\`, \`label3\`, \`label4\`, \`label5\`, \`label6\``;

    const labels = extractSuggestedLabels(response);
    
    assert.strictEqual(labels.length, 5);
  });

  test('filters out empty and whitespace-only labels', () => {
    const response = `**Suggested Labels:**
\`valid\`, \`   \`, \`also-valid\``;

    const labels = extractSuggestedLabels(response);
    
    // Whitespace-only label should be filtered out after trim
    assert.deepStrictEqual(labels, ['valid', 'also-valid']);
  });
  test('filters out excessively long labels', () => {
    const longLabel = 'x'.repeat(60);
    const response = `**Suggested Labels:**
\`${longLabel}\`, \`valid\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['valid']);
  });

  test('fallback to comma-separated if no backticks', () => {
    const response = `**Suggested Labels:**
risk: medium, area: auth, type: bugfix`;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: medium', 'area: auth', 'type: bugfix']);
  });

  test('case-insensitive labels section detection', () => {
    const response = `**suggested labels:**
\`risk: low\``;

    const labels = extractSuggestedLabels(response);
    
    assert.deepStrictEqual(labels, ['risk: low']);
  });
});
