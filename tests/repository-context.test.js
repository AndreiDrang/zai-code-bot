import { test, describe, expect, vi } from 'vitest';
const {
  collectRepositoryContext,
  renderRepositoryContext,
  fetchFile,
  globToRegExp,
  isExcluded,
  isUnderPrefix,
  normalizePathPrefix,
  KEY_FILES,
} = require('../src/lib/repository-context.js');

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

// Build an octokit mock with a git tree + per-file content responses.
function treeOctokit({ tree = [], files = {}, truncated = false, failTree = false } = {}) {
  return {
    rest: {
      git: {
        getTree: failTree
          ? vi.fn(async () => { throw Object.assign(new Error('boom'), { status: 500 }); })
          : vi.fn(async () => ({ data: { tree, truncated } })),
      },
      repos: {
        getContent: vi.fn(async ({ path }) => {
          if (files[path] === undefined) {
            const e = new Error('nf'); e.status = 404; throw e;
          }
          return { data: { type: 'file', content: Buffer.from(files[path], 'utf8').toString('base64') } };
        }),
      },
    },
  };
}

function blob(path) { return { type: 'blob', path }; }

describe('globToRegExp', () => {
  test('matches ** across directory separators', () => {
    const re = globToRegExp('node_modules/**');
    expect(re.test('node_modules/foo/bar.js')).toBe(true);
    expect(re.test('node_modules')).toBe(true);
    expect(re.test('src/index.js')).toBe(false);
  });

  test('matches single * within a segment', () => {
    const re = globToRegExp('*.min.js');
    expect(re.test('app.min.js')).toBe(true);
    expect(re.test('dir/app.min.js')).toBe(false); // * does not cross /
  });

  test('escapes regex metacharacters', () => {
    const re = globToRegExp('dist/bundle.js');
    expect(re.test('dist/bundle.js')).toBe(true);
    expect(re.test('distXbundle.js')).toBe(false);
  });
});

describe('isExcluded / isUnderPrefix / normalizePathPrefix', () => {
  test('isExcluded matches any of the compiled patterns', () => {
    const res = ['dist/**', '*.lock'].map(globToRegExp);
    expect(isExcluded('dist/x.js', res)).toBe(true);
    expect(isExcluded('yarn.lock', res)).toBe(true);
    expect(isExcluded('src/index.js', res)).toBe(false);
  });

  test('isUnderPrefix empty list means everywhere', () => {
    expect(isUnderPrefix('a/b.js', [])).toBe(true);
  });

  test('isUnderPrefix matches prefix boundary exactly', () => {
    const p = [normalizePathPrefix('src/lib')];
    expect(isUnderPrefix('src/lib/x.js', p)).toBe(true);
    expect(isUnderPrefix('src/libraries/x.js', p)).toBe(false);
    expect(isUnderPrefix('src/lib', p)).toBe(true);
  });

  test('normalizePathPrefix canonicalizes', () => {
    expect(normalizePathPrefix('.')).toBe('');
    expect(normalizePathPrefix('')).toBe('');
    expect(normalizePathPrefix('src/')).toBe('src');
    expect(normalizePathPrefix('src\\lib')).toBe('src/lib');
  });
});

describe('collectRepositoryContext', () => {
  test('discovers existing AGENTS.md files and includes them in contents', async () => {
    const tree = [
      blob('AGENTS.md'), blob('package.json'), blob('src/index.js'),
      blob('src/lib/AGENTS.md'), blob('README.md'), blob('node_modules/x.js'),
    ];
    const octokit = treeOctokit({
      tree,
      files: {
        'AGENTS.md': '# root agents',
        'package.json': '{"name":"zai"}',
        'README.md': '# readme',
        'src/lib/AGENTS.md': '# lib agents',
      },
    });

    const ctx = await collectRepositoryContext({
      octokit, owner: 'o', repo: 'r', branch: 'main', logger: fakeLogger(),
    });

    expect(ctx.existingAgentsFiles.sort()).toEqual(['AGENTS.md', 'src/lib/AGENTS.md']);
    expect(ctx.fileContents['AGENTS.md']).toBe('# root agents');
    expect(ctx.fileContents['package.json']).toBe('{"name":"zai"}');
    // node_modules excluded from tree and never fetched
    expect(ctx.tree).not.toContain('node_modules/x.js');
    expect(ctx.fileContents['node_modules/x.js']).toBeUndefined();
    expect(ctx.truncated).toBe(false);
  });

  test('respects context_paths to limit code files', async () => {
    const tree = [
      blob('src/index.js'), blob('tests/foo.test.js'), blob('README.md'),
    ];
    const octokit = treeOctokit({ tree, files: { 'README.md': 'r' } });

    const ctx = await collectRepositoryContext({
      octokit, owner: 'o', repo: 'r', branch: 'main',
      contextPaths: ['src'], logger: fakeLogger(),
    });

    expect(ctx.tree).toContain('tests/foo.test.js'); // tree is whole repo
    expect(ctx.fileContents['tests/foo.test.js']).toBeUndefined(); // not fetched (out of context scope)
  });

  test('respects exclude_paths (merged with defaults)', async () => {
    const tree = [blob('vendor/a.go'), blob('src/index.js'), blob('generated.gen.js')];
    const octokit = treeOctokit({ tree, files: {} });

    const ctx = await collectRepositoryContext({
      octokit, owner: 'o', repo: 'r', branch: 'main',
      excludePaths: ['generated/**', '*.gen.js'], logger: fakeLogger(),
    });

    expect(ctx.tree).not.toContain('vendor/a.go'); // default excludes vendor
    expect(ctx.tree).not.toContain('generated.gen.js'); // custom exclude
    expect(ctx.tree).toContain('src/index.js');
  });

  test('flags truncated tree from GitHub API', async () => {
    const octokit = treeOctokit({ tree: [blob('a.js')], truncated: true, files: {} });
    const ctx = await collectRepositoryContext({
      octokit, owner: 'o', repo: 'r', branch: 'main', logger: fakeLogger(),
    });
    expect(ctx.truncated).toBe(true);
  });

  test('survives tree fetch failure (empty tree, not crash)', async () => {
    const octokit = treeOctokit({ failTree: true, files: { 'package.json': '{}' } });
    const ctx = await collectRepositoryContext({
      octokit, owner: 'o', repo: 'r', branch: 'main', logger: fakeLogger(),
    });
    expect(ctx.totalFiles).toBe(0);
    expect(ctx.existingAgentsFiles).toEqual([]);
  });

  test('enforces max_context_chars budget', async () => {
    const big = 'x'.repeat(5000);
    const tree = [blob('a.js'), blob('b.js'), blob('c.js')];
    const octokit = treeOctokit({ tree, files: { 'a.js': big, 'b.js': big, 'c.js': big } });

    const ctx = await collectRepositoryContext({
      octokit, owner: 'o', repo: 'r', branch: 'main',
      maxContextChars: 6000, maxFileChars: 5000, logger: fakeLogger(),
    });

    const fetched = Object.keys(ctx.fileContents);
    // First file fits fully, second gets budget-limited; third never fetched.
    expect(fetched.length).toBeLessThanOrEqual(2);
    expect(ctx.contentCharCount).toBeLessThanOrEqual(6000 + 20); // +budget-limit note slack
  });

  test('enforces max_files_to_fetch cap', async () => {
    const tree = [blob('a.js'), blob('b.js'), blob('c.js'), blob('d.js')];
    const octokit = treeOctokit({ tree, files: {} });
    const ctx = await collectRepositoryContext({
      octokit, owner: 'o', repo: 'r', branch: 'main',
      maxFilesToFetch: 2, logger: fakeLogger(),
    });
    expect(ctx.filesFetched).toBeLessThanOrEqual(2);
  });

  test('normalizes and surfaces targetPaths on the context object', async () => {
    const octokit = treeOctokit({ tree: [blob('AGENTS.md')], files: { 'AGENTS.md': 'x' } });
    const ctx = await collectRepositoryContext({
      octokit, owner: 'o', repo: 'r', branch: 'main',
      targetPaths: ['src/lib/', 'tests'], logger: fakeLogger(),
    });
    expect(ctx.targetPaths.sort()).toEqual(['src/lib', 'tests']);
  });
});

describe('renderRepositoryContext', () => {
  test('includes tree, existing agents files, and file contents sections', () => {
    const ctx = {
      owner: 'o', repo: 'r', branch: 'main', truncated: false,
      tree: ['AGENTS.md', 'src/index.js'],
      existingAgentsFiles: ['AGENTS.md'],
      fileContents: { 'AGENTS.md': '# hi' },
      targetPaths: [],
    };
    const out = renderRepositoryContext(ctx);
    expect(out).toContain('Repository: o/r');
    expect(out).toContain('# Existing AGENTS.md files');
    expect(out).toContain('- AGENTS.md');
    expect(out).toContain('# Repository file tree (paths only):');
    expect(out).toContain('src/index.js');
    expect(out).toContain('## ===== AGENTS.md =====');
    expect(out).toContain('# hi');
  });

  test('notes truncation', () => {
    const out = renderRepositoryContext({ owner: 'o', repo: 'r', branch: 'main', truncated: true, tree: [], existingAgentsFiles: [], fileContents: {} });
    expect(out).toContain('truncated');
  });

  test('renders write-target restriction when targetPaths set', () => {
    const out = renderRepositoryContext({ owner: 'o', repo: 'r', branch: 'main', truncated: false, tree: [], existingAgentsFiles: [], fileContents: {}, targetPaths: ['src/lib'] });
    expect(out).toContain('Write targets are restricted');
    expect(out).toContain('src/lib');
  });

  test('handles null gracefully', () => {
    expect(renderRepositoryContext(null)).toContain('no repository context');
  });
});

describe('fetchFile', () => {
  test('returns null on 404', async () => {
    const octokit = treeOctokit({ files: {} });
    expect(await fetchFile(octokit, 'o', 'r', 'missing', 'main')).toBe(null);
  });

  test('returns decoded content for a file', async () => {
    const octokit = treeOctokit({ files: { 'a.txt': 'hello' } });
    expect(await fetchFile(octokit, 'o', 'r', 'a.txt', 'main')).toBe('hello');
  });

  test('returns null for non-file entries', async () => {
    const octokit = { rest: { repos: { getContent: vi.fn(async () => ({ data: { type: 'dir' } })) } } };
    expect(await fetchFile(octokit, 'o', 'r', 'somedir', 'main')).toBe(null);
  });
});

describe('KEY_FILES', () => {
  test('includes the expected repo-defining files', () => {
    expect(KEY_FILES).toContain('package.json');
    expect(KEY_FILES).toContain('action.yml');
    expect(KEY_FILES).toContain('README.md');
  });
});
