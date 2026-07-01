import { test, describe, expect, afterEach } from 'vitest';
const {
  getScheduledHandler,
  registerScheduledHandler,
  getAllScheduledHandlers,
  buildExecutionContext,
  parseFileUpdatesFromResponse,
  createPR,
  handleUpdateAgentsTask,
  executeScheduledTask,
} = require('../../src/lib/handlers/scheduled.js');

// Minimal no-op logger recording nothing; scheduled handlers only call info/warn/error.
function fakeLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a),
    error: (...a) => calls.error.push(a),
    debug: () => {},
    child: () => fakeLogger(),
    calls,
  };
}

// Build an octokit mock with a call log so we can assert invocation order/args.
function recordingOctokit(handlers = {}) {
  const calls = [];
  const getContent = handlers.getContent || (async (args) => ({ data: { sha: 'sha-' + args.path } }));
  const rest = {
    repos: {
      getContent: async (args) => { calls.push({ name: 'getContent', args }); return getContent(args); },
      createOrUpdateFileContents: async (args) => {
        calls.push({ name: 'createOrUpdateFileContents', args });
        return { data: { commit: { sha: 'commit-' + args.path } } };
      },
    },
    git: {
      getRef: async (args) => { calls.push({ name: 'getRef', args }); return { data: { object: { sha: 'basesha' } } }; },
      createRef: async (args) => { calls.push({ name: 'createRef', args }); return { data: {} }; },
    },
    pulls: {
      create: async (args) => {
        calls.push({ name: 'pulls.create', args });
        return { data: { number: 42, html_url: 'https://github.com/o/r/pull/42' } };
      },
    },
  };
  return { rest, calls };
}

describe('handler registry', () => {
  test('getScheduledHandler returns the update-agents handler', () => {
    expect(typeof getScheduledHandler('update-agents')).toBe('function');
  });

  test('getScheduledHandler returns null for unknown commands', () => {
    expect(getScheduledHandler('does-not-exist')).toBe(null);
  });

  test('registerScheduledHandler adds a handler that getScheduledHandler resolves', () => {
    const fake = async () => ({ success: true });
    registerScheduledHandler('test-command', fake);
    expect(getScheduledHandler('test-command')).toBe(fake);
  });

  test('getAllScheduledHandlers returns a copy that is safe to mutate', () => {
    const before = Object.keys(getAllScheduledHandlers());
    const snapshot = getAllScheduledHandlers();
    snapshot['injected'] = () => {};
    // mutating the returned copy must not affect the live registry
    expect(getAllScheduledHandlers()['injected']).toBeUndefined();
    expect(Object.keys(getAllScheduledHandlers()).sort()).toEqual(before.sort());
  });

  afterEach(() => {
    // restore registry to baseline (remove any test-only handlers)
    if (getScheduledHandler('test-command')) {
      registerScheduledHandler('test-command', null);
    }
  });
});

describe('buildExecutionContext', () => {
  test('resolves targetBranch from task.config.branch first', () => {
    const ctx = buildExecutionContext({
      octokit: {}, apiKey: 'k', model: 'm', owner: 'o', repo: 'r',
      task: { config: { branch: 'feature' } },
      config: { defaults: { branch: 'develop' } },
      logger: fakeLogger(), context: {},
    });
    expect(ctx.targetBranch).toBe('feature');
  });

  test('falls back to config.defaults.branch', () => {
    const ctx = buildExecutionContext({
      octokit: {}, task: { config: {} },
      config: { defaults: { branch: 'develop' } },
      logger: fakeLogger(), context: {},
    });
    expect(ctx.targetBranch).toBe('develop');
  });

  test('falls back to main when no branch is configured', () => {
    const ctx = buildExecutionContext({
      octokit: {}, task: { config: {} },
      config: { defaults: {} },
      logger: fakeLogger(), context: {},
    });
    expect(ctx.targetBranch).toBe('main');
  });

  test('injects all expected utility helpers', () => {
    const ctx = buildExecutionContext({
      octokit: {}, task: { config: {} }, config: { defaults: {} },
      logger: fakeLogger(), context: {},
    });
    for (const fn of ['fetchFromUrl', 'fetchFile', 'updateFile', 'createPullRequest', 'getFileSha']) {
      expect(typeof ctx[fn]).toBe('function');
    }
    expect(ctx.targetBranch).toBe('main');
  });
});

describe('parseFileUpdatesFromResponse', () => {
  // fetchFileContent(octokit, owner, repo, path, ref) -> string|null
  function makeFetcher(existing = {}) {
    return async (_octokit, _owner, _repo, path) => existing[path] ?? null;
  }

  test('parses structured JSON with changed + unchanged files', async () => {
    const response = JSON.stringify({
      files: [
        { path: 'AGENTS.md', content: 'new content' },          // changed (was null -> isNew)
        { path: 'src/AGENTS.md', content: 'same', action: 'unchanged-action' },
      ],
    });
    const fetcher = makeFetcher({ 'src/AGENTS.md': 'same' });
    const updates = await parseFileUpdatesFromResponse(response, {}, 'o', 'r', 'main', fetcher, fakeLogger());

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ file: 'AGENTS.md', newContent: 'new content', changed: true, isNew: true });
    expect(updates[1]).toMatchObject({ file: 'src/AGENTS.md', changed: false });
  });

  test('treats action "updated" as changed even when content matches', async () => {
    const response = JSON.stringify({
      files: [{ path: 'AGENTS.md', content: 'same', action: 'updated' }],
    });
    const fetcher = makeFetcher({ 'AGENTS.md': 'same' });
    const updates = await parseFileUpdatesFromResponse(response, {}, 'o', 'r', 'main', fetcher, fakeLogger());
    expect(updates[0].changed).toBe(true);
  });

  test('accepts "file" alias for path and "body" alias for content', async () => {
    const response = JSON.stringify({
      files: [{ file: 'docs/AGENTS.md', body: 'B' }],
    });
    const updates = await parseFileUpdatesFromResponse(response, {}, 'o', 'r', 'main', makeFetcher(), fakeLogger());
    expect(updates[0].file).toBe('docs/AGENTS.md');
    expect(updates[0].newContent).toBe('B');
  });

  test('skips entries missing path or content', async () => {
    const response = JSON.stringify({
      files: [
        { content: 'no path' },
        { path: 'no content' },
        { path: 'good.md', content: 'ok' },
      ],
    });
    const updates = await parseFileUpdatesFromResponse(response, {}, 'o', 'r', 'main', makeFetcher(), fakeLogger());
    expect(updates.map(u => u.file)).toEqual(['good.md']);
  });

  test('falls back to text extraction (AGENTS.md) when response is not JSON', async () => {
    const text = 'This is plain markdown, not JSON at all.';
    const updates = await parseFileUpdatesFromResponse(text, {}, 'o', 'r', 'main', makeFetcher(), fakeLogger());
    expect(updates).toHaveLength(1);
    expect(updates[0].file).toBe('AGENTS.md');
    expect(updates[0].newContent).toBe(text);
    expect(updates[0].changed).toBe(true);
    expect(updates[0].isNew).toBe(true);
  });

  test('extracts JSON embedded inside a markdown fenced block', async () => {
    const response = 'Here is the plan:\n```json\n{"files":[{"path":"AGENTS.md","content":"x"}]}\n```\nDone.';
    const updates = await parseFileUpdatesFromResponse(response, {}, 'o', 'r', 'main', makeFetcher(), fakeLogger());
    expect(updates).toHaveLength(1);
    expect(updates[0].file).toBe('AGENTS.md');
    expect(updates[0].newContent).toBe('x');
  });
});

describe('createPR', () => {
  test('creates branch, commits files, opens PR, returns PR data', async () => {
    const octokit = recordingOctokit({});

    const result = await createPR(octokit, 'o', 'r', {
      title: 'chore: update AGENTS.md',
      body: 'body text',
      base: 'main',
      files: [{ path: 'AGENTS.md', content: 'new' }, { path: 'src/AGENTS.md', content: 'new2' }],
      commitMessage: 'docs: update',
    }, fakeLogger());

    const sequence = octokit.calls.map(c => c.name);

    // getRef (base) then createRef (branch) once each
    expect(sequence.filter(n => n === 'getRef')).toHaveLength(1);
    expect(sequence.filter(n => n === 'createRef')).toHaveLength(1);
    // getFileSha + commit per file -> 2 createOrUpdateFileContents calls
    expect(sequence.filter(n => n === 'createOrUpdateFileContents')).toHaveLength(2);
    // finally opens the PR
    expect(sequence.filter(n => n === 'pulls.create')).toHaveLength(1);
    expect(sequence[sequence.length - 1]).toBe('pulls.create');

    // branch name pattern zai-scheduled/YYYY.MM.DD_HH.MM, head = that branch
    const prArgs = octokit.calls.find(c => c.name === 'pulls.create').args;
    expect(prArgs.head).toMatch(/^zai-scheduled\/\d{4}\.\d{2}\.\d{2}_\d{2}\.\d{2}$/);
    expect(prArgs.base).toBe('main');
    expect(prArgs.title).toBe('chore: update AGENTS.md');

    expect(result.number).toBe(42);
    expect(result.html_url).toBe('https://github.com/o/r/pull/42');
    expect(result.commitSha).toBe('commit-src/AGENTS.md');
  });

  test('tolerates an already-existing branch (422)', async () => {
    const err = Object.assign(new Error('exists'), { status: 422 });
    const octokit = recordingOctokit({});
    octokit.rest.git.createRef = async () => { throw err; };

    const result = await createPR(octokit, 'o', 'r', {
      title: 't', body: 'b', base: 'main',
      files: [{ path: 'AGENTS.md', content: 'x' }],
      commitMessage: 'm',
    }, fakeLogger());
    expect(result.number).toBe(42);
  });
});

describe('handleUpdateAgentsTask (early returns)', () => {
  function baseContext(overrides = {}) {
    return {
      octokit: {}, apiKey: 'k', model: 'm', owner: 'o', repo: 'r',
      task: { id: 'weekly', command: 'update-agents', config: { gist_url: 'https://gist.example' } },
      config: { defaults: { branch: 'main' } },
      logger: fakeLogger(), targetBranch: 'main',
      fetchFromUrl: async () => 'gist content',
      fetchFile: async () => null,
      createPullRequest: async (p) => ({ number: 7, html_url: 'u' }),
      ...overrides,
    };
  }

  test('fails when no gist_url is configured anywhere', async () => {
    const result = await handleUpdateAgentsTask(baseContext({
      task: { id: 'weekly', command: 'update-agents', config: {} },
      config: { defaults: {} },
    }));
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing gist_url configuration');
  });

  test('fails when gist fetch throws', async () => {
    const result = await handleUpdateAgentsTask(baseContext({
      fetchFromUrl: async () => { throw new Error('network down'); },
    }));
    expect(result.success).toBe(false);
    expect(result.error.startsWith('Failed to fetch from gist')).toBe(true);
  });

  test('fails when gist returns empty content', async () => {
    const result = await handleUpdateAgentsTask(baseContext({
      fetchFromUrl: async () => '   ',
    }));
    expect(result.success).toBe(false);
    expect(result.error).toBe('Empty response from gist URL');
  });
});

describe('executeScheduledTask', () => {
  test('returns an error result for an unknown command', async () => {
    const result = await executeScheduledTask({
      octokit: {}, apiKey: 'k', model: 'm', owner: 'o', repo: 'r',
      task: { id: 't1', command: 'totally-unknown' },
      config: { defaults: {} },
      logger: fakeLogger(), context: {},
    });
    expect(result.success).toBe(false);
    expect(result.taskId).toBe('t1');
    expect(result.error.startsWith('Unknown scheduled command')).toBe(true);
  });

  test('runs a registered handler and maps its result', async () => {
    const fakeHandler = async () => ({
      success: true,
      changes: [{ file: 'AGENTS.md', changed: true }],
      prCreated: true,
      prNumber: 9,
      prUrl: 'https://github.com/o/r/pull/9',
    });
    registerScheduledHandler('test-runner', fakeHandler);
    try {
      const result = await executeScheduledTask({
        octokit: {}, apiKey: 'k', model: 'm', owner: 'o', repo: 'r',
        task: { id: 't1', command: 'test-runner' },
        config: { defaults: {} },
        logger: fakeLogger(), context: {},
      });
      expect(result.success).toBe(true);
      expect(result.prCreated).toBe(true);
      expect(result.prNumber).toBe(9);
      expect(result.changes).toHaveLength(1);
    } finally {
      registerScheduledHandler('test-runner', null);
    }
  });
});
