import { test, describe, expect } from 'vitest';

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

  expect(newRanges).toEqual([
    { start: 20, end: 23 },
    { start: 80, end: 81 },
  ]);
  expect(oldRanges).toEqual([
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

  expect(scoped.scoped).toBe(true);
  expect(scoped.scopeStrategy).toBe('sliding_window');
  expect(scoped.scopeStartLine).toBe(10990);
  expect(scoped.scopeEndLine).toBe(11020);
  expect(scoped.content.includes('line 11000')).toBe(true);
  expect(scoped.scopeStartLine > 1).toBeTruthy();
  expect(scoped.content.startsWith('line 1\n')).toBeFalsy();
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

  expect(scoped.scoped).toBe(true);
  expect(scoped.scopeStrategy).toBe('enclosing_block');
  expect(scoped.content).toContain('function targetBlock() {');
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

  expect(result.success).toBe(true);
  expect(result.scoped).toBe(true);
  expect(result.scopeStrategy).toBe('sliding_window');
  expect(result.data.includes('line 10020')).toBe(true);
  expect(result.scopeStartLine > 1).toBeTruthy();
  expect(result.data.startsWith('line 1\n')).toBeFalsy();
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

  expect(result.success).toBe(true);
  expect(result.data.length).toBe(2);
  expect(result.data[0].filename).toBe('test.js');
  expect(result.data[1].filename).toBe('new.js');
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

  expect(result.success).toBe(false);
  expect(result.fallback.includes('Content not found')).toBe(true);
  expect(result.error).toBeTruthy();
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

  expect(result.success).toBe(false);
  expect(result.fallback.includes('rate limit')).toBe(true);
  expect(result.error).toBeTruthy();
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

  expect(result.success).toBe(false);
  expect(result.fallback.includes('temporarily unavailable')).toBe(true);
  expect(result.error).toBeTruthy();
});

test('mapErrorToFallback maps 404 to NOT_FOUND category', () => {
  const error = { status: 404, message: 'Not Found' };
  const result = mapErrorToFallback(error, 'test-file.js');

  expect(result.category).toBe('NOT_FOUND');
  expect(result.fallback.includes('test-file.js')).toBe(true);
});

test('mapErrorToFallback maps 429 to RATE_LIMIT category', () => {
  const error = { status: 429, message: 'Rate limit exceeded' };
  const result = mapErrorToFallback(error, 'test-file.js');

  expect(result.category).toBe('RATE_LIMIT');
  expect(result.fallback.includes('rate limit')).toBe(true);
});

test('mapErrorToFallback maps 403 to PERMISSION category', () => {
  const error = { status: 403, message: 'Forbidden' };
  const result = mapErrorToFallback(error, 'test-file.js');

  expect(result.category).toBe('PERMISSION');
  expect(result.fallback.includes('Permission denied')).toBe(true);
});

test('mapErrorToFallback maps 500+ to PROVIDER category', () => {
  const error = { status: 502, message: 'Bad Gateway' };
  const result = mapErrorToFallback(error, 'test-file.js');

  expect(result.category).toBe('PROVIDER');
  expect(result.fallback.includes('unavailable')).toBe(true);
});

test('mapErrorToFallback maps unknown errors to UNKNOWN category', () => {
  const error = { status: 418, message: 'Unknown error' };
  const result = mapErrorToFallback(error, 'test-file.js');

  expect(result.category).toBe('UNKNOWN');
  expect(result.fallback.includes('Failed to retrieve')).toBe(true);
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

  expect(result.success).toBe(false);
  expect(result.error.includes('required')).toBe(true);
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

  expect(result.success).toBe(false);
  expect(result.error.includes('required')).toBe(true);
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

  expect(result.success).toBe(false);
  expect(result.error.includes('directory')).toBe(true);
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

  expect(result.success).toBe(false);
  expect(result.error.includes('not available')).toBe(true);
  expect(result.fallback.includes('Binary')).toBe(true);
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

  expect(result.success).toBe(true);
  expect(result.truncated).toBe(true);
  expect(result.omitted > 0).toBeTruthy();
  expect(result.data.length <= 100000).toBeTruthy();
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

  expect(result.success).toBe(true);
  expect(result.scoped).toBe(true);
  expect(result.scopeStrategy).toBeTruthy();
  expect(result.lineCount > 10000).toBeTruthy();
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

  expect(result.success).toBe(false);
  expect(result.fallback).toBeTruthy();
  expect(result.error).toBeTruthy();
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

  expect(result.success).toBe(true);
  expect(result.data.base.ref).toBe('main');
  expect(result.data.base.sha).toBe('abc123base');
  expect(result.data.head.ref).toBe('feature-branch');
  expect(result.data.head.sha).toBe('def456head');
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

  expect(result.success).toBe(false);
  expect(result.error.includes('not found')).toBe(true);
  expect(result.fallback.includes('unavailable')).toBe(true);
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

  expect(result.success).toBe(false);
  expect(result.fallback).toBeTruthy();
  expect(result.error).toBeTruthy();
});

test('resolvePrRefs returns error for missing pullNumber', async () => {
  const mockOctokit = {};

  const result = await resolvePrRefs(mockOctokit, 'owner', 'repo', null);

  expect(result.success).toBe(false);
  expect(result.error.includes('required')).toBe(true);
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

  expect(result.success).toBe(true);
  expect(capturedRef).toBe('resolved-sha');
  expect(capturedOptions.path).toBe('src/file.js');
  expect(capturedOptions.ref).toBeTruthy();
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

  expect(result.success).toBe(false);
  expect(result.fallback).toBeTruthy();
  expect(result.error).toBeTruthy();
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

  expect(result.success).toBe(true);
  expect(result.data.includes('hello')).toBe(true);
});
