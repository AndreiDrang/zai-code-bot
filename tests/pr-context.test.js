const test = require('node:test');
const assert = require('node:assert');

const {
  parsePatchLineRanges,
  scopeLargeFileContent,
  fetchFileAtRef,
  fetchPrFiles,
  resolvePrRefs,
  fetchFileAtPrHead,
  mapErrorToFallback,
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

// fetchPrFiles tests

test('fetchPrFiles returns file list on success', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        listFiles: async () => ({
          data: [
            { filename: 'test.js', status: 'modified', patch: '+x' },
            { filename: 'new.js', status: 'added', patch: '+y' }
          ]
        })
      }
    }
  };

  const result = await fetchPrFiles(mockOctokit, 'owner', 'repo', 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.length, 2);
  assert.strictEqual(result.data[0].filename, 'test.js');
  assert.strictEqual(result.data[1].filename, 'new.js');
});

test('fetchPrFiles returns fallback on 404 error', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        listFiles: async () => {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }
      }
    }
  };

  const result = await fetchPrFiles(mockOctokit, 'owner', 'repo', 1);

  assert.strictEqual(result.success, false);
  assert.ok(result.fallback.includes('Content not found'));
  assert.ok(result.error);
});

test('fetchPrFiles returns fallback on 429 rate limit error', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        listFiles: async () => {
          const error = new Error('Rate limit exceeded');
          error.status = 429;
          throw error;
        }
      }
    }
  };

  const result = await fetchPrFiles(mockOctokit, 'owner', 'repo', 1);

  assert.strictEqual(result.success, false);
  assert.ok(result.fallback.includes('rate limit'));
  assert.ok(result.error);
});

test('fetchPrFiles returns fallback on 500 server error', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        listFiles: async () => {
          const error = new Error('Internal Server Error');
          error.status = 500;
          throw error;
        }
      }
    }
  };

  const result = await fetchPrFiles(mockOctokit, 'owner', 'repo', 1);

  assert.strictEqual(result.success, false);
  assert.ok(result.fallback.includes('temporarily unavailable'));
  assert.ok(result.error);
});

test('mapErrorToFallback maps 404 to NOT_FOUND category', () => {
  const error = { status: 404, message: 'Not Found' };
  const result = mapErrorToFallback(error, 'test-file.js');

  assert.strictEqual(result.category, 'NOT_FOUND');
  assert.ok(result.fallback.includes('test-file.js'));
});

test('mapErrorToFallback maps 429 to RATE_LIMIT category', () => {
  const error = { status: 429, message: 'Rate limit exceeded' };
  const result = mapErrorToFallback(error, 'test-file.js');

  assert.strictEqual(result.category, 'RATE_LIMIT');
  assert.ok(result.fallback.includes('rate limit'));
});

test('mapErrorToFallback maps 403 to PERMISSION category', () => {
  const error = { status: 403, message: 'Forbidden' };
  const result = mapErrorToFallback(error, 'test-file.js');

  assert.strictEqual(result.category, 'PERMISSION');
  assert.ok(result.fallback.includes('Permission denied'));
});

test('mapErrorToFallback maps 500+ to PROVIDER category', () => {
  const error = { status: 502, message: 'Bad Gateway' };
  const result = mapErrorToFallback(error, 'test-file.js');

  assert.strictEqual(result.category, 'PROVIDER');
  assert.ok(result.fallback.includes('unavailable'));
});

test('mapErrorToFallback maps unknown errors to UNKNOWN category', () => {
  const error = { status: 418, message: 'Unknown error' };
  const result = mapErrorToFallback(error, 'test-file.js');

  assert.strictEqual(result.category, 'UNKNOWN');
  assert.ok(result.fallback.includes('Failed to retrieve'));
});

// fetchFileAtRef tests

test('fetchFileAtRef returns error for invalid path', async () => {
  const mockOctokit = {
    rest: {
      repos: {
        getContent: async () => ({ data: {} })
      }
    }
  };

  const result = await fetchFileAtRef(mockOctokit, 'owner', 'repo', '', 'main');

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('required'));
});

test('fetchFileAtRef returns error for invalid ref', async () => {
  const mockOctokit = {
    rest: {
      repos: {
        getContent: async () => ({ data: {} })
      }
    }
  };

  const result = await fetchFileAtRef(mockOctokit, 'owner', 'repo', 'file.js', '');

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('required'));
});

test('fetchFileAtRef handles directory response correctly', async () => {
  const mockOctokit = {
    rest: {
      repos: {
        getContent: async () => ({
          data: []
        })
      }
    }
  };

  const result = await fetchFileAtRef(mockOctokit, 'owner', 'repo', 'src/', 'main');

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('directory'));
});

test('fetchFileAtRef handles binary/no-content response correctly', async () => {
  const mockOctokit = {
    rest: {
      repos: {
        getContent: async () => ({
          data: {
            name: 'image.png',
            content: null
          }
        })
      }
    }
  };

  const result = await fetchFileAtRef(mockOctokit, 'owner', 'repo', 'image.png', 'main');

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('not available'));
  assert.ok(result.fallback.includes('Binary'));
});

test('fetchFileAtRef returns truncated flag when content exceeds maxFileSize', async () => {
  const largeContent = 'a'.repeat(200000);
  const mockOctokit = {
    rest: {
      repos: {
        getContent: async () => ({
          data: {
            content: Buffer.from(largeContent, 'utf8').toString('base64')
          }
        })
      }
    }
  };

  const result = await fetchFileAtRef(
    mockOctokit,
    'owner',
    'repo',
    'large.js',
    'sha123',
    { maxFileSize: 100000 }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.truncated, true);
  assert.ok(result.omitted > 0);
  assert.ok(result.data.length <= 100000);
});

test('fetchFileAtRef returns scoped metadata for large files', async () => {
  const content = Array.from({ length: 15000 }, (_, i) => `line ${i + 1}`).join('\n');
  const mockOctokit = {
    rest: {
      repos: {
        getContent: async () => ({
          data: {
            content: Buffer.from(content, 'utf8').toString('base64')
          }
        })
      }
    }
  };

  const result = await fetchFileAtRef(
    mockOctokit,
    'owner',
    'repo',
    'large.js',
    'sha123',
    { maxFileLines: 10000 }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.scoped, true);
  assert.ok(result.scopeStrategy);
  assert.ok(result.lineCount > 10000);
});

test('fetchFileAtRef returns fallback on API error', async () => {
  const mockOctokit = {
    rest: {
      repos: {
        getContent: async () => {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }
      }
    }
  };

  const result = await fetchFileAtRef(mockOctokit, 'owner', 'repo', 'missing.js', 'main');

  assert.strictEqual(result.success, false);
  assert.ok(result.fallback);
  assert.ok(result.error);
});

// resolvePrRefs tests

test('resolvePrRefs returns base and head refs on success', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            base: { ref: 'main', sha: 'abc123base' },
            head: { ref: 'feature-branch', sha: 'def456head' }
          }
        })
      }
    }
  };

  const result = await resolvePrRefs(mockOctokit, 'owner', 'repo', 1);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.base.ref, 'main');
  assert.strictEqual(result.data.base.sha, 'abc123base');
  assert.strictEqual(result.data.head.ref, 'feature-branch');
  assert.strictEqual(result.data.head.sha, 'def456head');
});

test('resolvePrRefs handles missing refs metadata gracefully', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            base: { ref: 'main' },
            head: { sha: 'def456head' }
          }
        })
      }
    }
  };

  const result = await resolvePrRefs(mockOctokit, 'owner', 'repo', 1);

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('not found'));
  assert.ok(result.fallback.includes('unavailable'));
});

test('resolvePrRefs returns fallback on API error', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        get: async () => {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }
      }
    }
  };

  const result = await resolvePrRefs(mockOctokit, 'owner', 'repo', 1);

  assert.strictEqual(result.success, false);
  assert.ok(result.fallback);
  assert.ok(result.error);
});

test('resolvePrRefs returns error for missing pullNumber', async () => {
  const mockOctokit = {};

  const result = await resolvePrRefs(mockOctokit, 'owner', 'repo', null);

  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('required'));
});

// fetchFileAtPrHead tests

test('fetchFileAtPrHead forwards resolved SHA and options to fetchFileAtRef', async () => {
  let capturedRef = null;
  let capturedOptions = null;

  const mockOctokit = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            base: { ref: 'main', sha: 'abc123base' },
            head: { ref: 'feature', sha: 'resolved-sha' }
          }
        })
      },
      repos: {
        getContent: async (params) => {
          capturedRef = params.ref;
          capturedOptions = params;
          return {
            data: {
              content: Buffer.from('file content', 'utf8').toString('base64')
            }
          };
        }
      }
    }
  };

  const result = await fetchFileAtPrHead(
    mockOctokit,
    'owner',
    'repo',
    'src/file.js',
    1,
    { maxFileSize: 50000 }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(capturedRef, 'resolved-sha');
  assert.strictEqual(capturedOptions.path, 'src/file.js');
  assert.ok(capturedOptions.ref);
});

test('fetchFileAtPrHead returns error when resolvePrRefs fails', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        get: async () => {
          const error = new Error('Not Found');
          error.status = 404;
          throw error;
        }
      }
    }
  };

  const result = await fetchFileAtPrHead(mockOctokit, 'owner', 'repo', 'file.js', 1);

  assert.strictEqual(result.success, false);
  assert.ok(result.fallback);
  assert.ok(result.error);
});

test('fetchFileAtPrHead success path returns file content', async () => {
  const mockOctokit = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            base: { ref: 'main', sha: 'abc123base' },
            head: { ref: 'feature', sha: 'def456head' }
          }
        })
      },
      repos: {
        getContent: async () => ({
          data: {
            content: Buffer.from('console.log("hello");', 'utf8').toString('base64')
          }
        })
      }
    }
  };

  const result = await fetchFileAtPrHead(mockOctokit, 'owner', 'repo', 'hello.js', 1);

  assert.strictEqual(result.success, true);
  assert.ok(result.data.includes('hello'));
});
