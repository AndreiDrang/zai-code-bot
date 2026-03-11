import { test, describe, expect } from 'vitest';

const {
  fetchAllChangedFiles,
  fetchChangedFiles,
  MAX_PR_FILES_API_LIMIT,
} = require('../src/lib/changed-files');

describe('changed-files', () => {
  test('fetchAllChangedFiles paginates until final partial page', async () => {
    const calls = [];
    const octokit = {
      rest: {
        pulls: {
          listFiles: async (params) => {
            calls.push(params.page);
            if (params.page === 1) {
              return { data: Array.from({ length: 100 }, (_, index) => ({ filename: `src/${index}.js` })) };
            }
            if (params.page === 2) {
              return { data: Array.from({ length: 20 }, (_, index) => ({ filename: `src/extra-${index}.js` })) };
            }
            return { data: [] };
          }
        }
      }
    };

    const result = await fetchAllChangedFiles(octokit, 'owner', 'repo', 1);

    expect(calls).toEqual([1, 2]);
    expect(result.files.length).toBe(120);
    expect(result.limitReached).toBe(false);
  });

  test('fetchAllChangedFiles reports GitHub ceiling when max file limit is hit', async () => {
    const octokit = {
      rest: {
        pulls: {
          listFiles: async () => ({
            data: Array.from({ length: 100 }, (_, index) => ({ filename: `src/${index}.js` }))
          })
        }
      }
    };

    const result = await fetchAllChangedFiles(octokit, 'owner', 'repo', 1, { maxFiles: 200 });

    expect(result.files.length).toBe(200);
    expect(result.limitReached).toBe(true);
  });

  test('fetchChangedFiles returns only the file array', async () => {
    const octokit = {
      rest: {
        pulls: {
          listFiles: async () => ({ data: [{ filename: 'a.js' }] })
        }
      }
    };

    const files = await fetchChangedFiles(octokit, 'owner', 'repo', 1, { maxFiles: MAX_PR_FILES_API_LIMIT });

    expect(files).toEqual([{ filename: 'a.js' }]);
  });
});
