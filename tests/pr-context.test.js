const test = require('node:test');
const assert = require('node:assert');

const {
  parsePatchLineRanges,
  scopeLargeFileContent,
  fetchFileAtRef,
} = require('../src/lib/pr-context');

function buildLargeFile(lineCount = 12050) {
  return Array.from({ length: lineCount }, (_, idx) => `line ${idx + 1}`).join('\n');
}

test('parsePatchLineRanges parses new and old hunk ranges', () => {
  const patch = [
    '@@ -10,3 +20,4 @@',
    '-oldA',
    '+newA',
    '@@ -50,1 +80,2 @@',
    '-oldB',
    '+newB',
  ].join('\n');

  const newRanges = parsePatchLineRanges(patch, 'new');
  const oldRanges = parsePatchLineRanges(patch, 'old');

  assert.deepStrictEqual(newRanges, [
    { start: 20, end: 23 },
    { start: 80, end: 81 },
  ]);
  assert.deepStrictEqual(oldRanges, [
    { start: 10, end: 12 },
    { start: 50, end: 50 },
  ]);
});

test('scopeLargeFileContent uses sliding window for >10k lines with changed ranges', () => {
  const content = buildLargeFile(12050);
  const scoped = scopeLargeFileContent(content, {
    maxFileLines: 10000,
    changedRanges: [{ start: 11000, end: 11010 }],
    windowSize: 10,
  });

  assert.strictEqual(scoped.scoped, true);
  assert.strictEqual(scoped.scopeStrategy, 'sliding_window');
  assert.strictEqual(scoped.scopeStartLine, 10990);
  assert.strictEqual(scoped.scopeEndLine, 11020);
  assert.ok(scoped.content.includes('line 11000'));
  assert.ok(scoped.scopeStartLine > 1);
  assert.ok(!scoped.content.startsWith('line 1\n'));
});

test('scopeLargeFileContent uses enclosing block strategy when requested', () => {
  const content = [
    ...Array.from({ length: 11020 }, (_, idx) => `line ${idx + 1}`),
    'function targetBlock() {',
    '  const x = 1;',
    '  return x + 1;',
    '}',
    ...Array.from({ length: 200 }, (_, idx) => `tail ${idx + 1}`),
  ].join('\n');

  const scoped = scopeLargeFileContent(content, {
    maxFileLines: 10000,
    anchorLine: 11022,
    preferEnclosingBlock: true,
  });

  assert.strictEqual(scoped.scoped, true);
  assert.strictEqual(scoped.scopeStrategy, 'enclosing_block');
  assert.ok(scoped.content.includes('function targetBlock() {'));
});

test('fetchFileAtRef returns scoped content metadata for very large files', async () => {
  const largeFile = buildLargeFile(12050);
  const octokit = {
    rest: {
      repos: {
        getContent: async () => ({
          data: {
            content: Buffer.from(largeFile, 'utf8').toString('base64'),
          },
        }),
      },
    },
  };

  const result = await fetchFileAtRef(
    octokit,
    'owner',
    'repo',
    'src/file.js',
    'sha123',
    {
      maxFileSize: 200000,
      maxFileLines: 10000,
      changedRanges: [{ start: 10020, end: 10035 }],
      windowSize: 8,
      maxWindows: 1,
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.scoped, true);
  assert.strictEqual(result.scopeStrategy, 'sliding_window');
  assert.ok(result.data.includes('line 10020'));
  assert.ok(result.scopeStartLine > 1);
  assert.ok(!result.data.startsWith('line 1\n'));
});
