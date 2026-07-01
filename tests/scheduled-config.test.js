import { test, describe, expect, beforeEach, afterEach } from 'vitest';
const {
  CONFIG_VERSION,
  loadScheduledConfig,
  validateAndNormalizeConfig,
  validateDefaults,
  validateAndNormalizeTask,
  getTasksToRun,
  getTaskById,
  areScheduledTasksEnabled,
  getGistUrl,
} = require('../src/lib/config/scheduled-config.js');

const yaml = require('yaml');

// Build a base64-encoded getContent() response from a raw config string.
function contentResponse(rawConfig) {
  return {
    data: {
      content: Buffer.from(rawConfig, 'utf8').toString('base64'),
    },
  };
}

function buildOctokit({ getContent }) {
  return {
    rest: {
      repos: {
        getContent,
      },
    },
  };
}

describe('CONFIG_VERSION', () => {
  test('equals 1', () => {
    expect(CONFIG_VERSION).toBe(1);
  });
});

describe('getGistUrl', () => {
  const prevEnv = process.env.ZAI_AGENTS_GIST_URL;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.ZAI_AGENTS_GIST_URL;
    else process.env.ZAI_AGENTS_GIST_URL = prevEnv;
  });

  test('prefers task config gist_url', () => {
    process.env.ZAI_AGENTS_GIST_URL = 'https://env.example';
    expect(getGistUrl({ gist_url: 'https://task.example' }, { gist_url: 'https://defaults.example' }))
      .toBe('https://task.example');
  });

  test('falls back to defaults gist_url when task has none', () => {
    expect(getGistUrl({}, { gist_url: 'https://defaults.example' })).toBe('https://defaults.example');
  });

  test('falls back to env var when no task or defaults value', () => {
    process.env.ZAI_AGENTS_GIST_URL = 'https://env.example';
    expect(getGistUrl({}, {})).toBe('https://env.example');
  });

  test('returns null when nothing is configured', () => {
    delete process.env.ZAI_AGENTS_GIST_URL;
    expect(getGistUrl({}, {})).toBe(null);
  });

  test('returns null for undefined inputs', () => {
    delete process.env.ZAI_AGENTS_GIST_URL;
    expect(getGistUrl(undefined, undefined)).toBe(null);
  });
});

describe('validateDefaults', () => {
  test('merges provided values over built-in DEFAULTS', () => {
    const result = validateDefaults({ branch: 'develop', gist_url: 'https://g.example' });
    expect(result.branch).toBe('develop');
    expect(result.gist_url).toBe('https://g.example');
    expect(result.schedule).toBe('0 0 * * 0'); // default retained
    expect(result.enabled).toBe(true); // default retained
  });

  test('returns built-in DEFAULTS for empty input', () => {
    const result = validateDefaults({});
    expect(result).toEqual({ branch: 'main', schedule: '0 0 * * 0', enabled: true });
  });

  test('throws when branch is not a string', () => {
    expect(() => validateDefaults({ branch: 123 })).toThrow('defaults.branch must be a string');
  });

  test('throws when schedule is not a string', () => {
    expect(() => validateDefaults({ schedule: 42 })).toThrow('defaults.schedule must be a string');
  });

  test('throws when gist_url is not a string', () => {
    expect(() => validateDefaults({ gist_url: [] })).toThrow('defaults.gist_url must be a string');
  });
});

describe('validateAndNormalizeTask', () => {
  const defaults = { branch: 'main', schedule: '0 0 * * 0', enabled: true };

  test('throws when task id is missing', () => {
    expect(() => validateAndNormalizeTask({ command: 'update-agents' }, 0, defaults))
      .toThrow('Task 0 missing required field: id');
  });

  test('throws when task id is not a string', () => {
    expect(() => validateAndNormalizeTask({ id: 5, command: 'update-agents' }, 0, defaults))
      .toThrow("Task 0 field 'id' must be a string");
  });

  test('throws when command is missing', () => {
    expect(() => validateAndNormalizeTask({ id: 't1' }, 0, defaults))
      .toThrow('Task t1 missing required field: command');
  });

  test('throws when command is not a string', () => {
    expect(() => validateAndNormalizeTask({ id: 't1', command: 9 }, 0, defaults))
      .toThrow("Task t1 field 'command' must be a string");
  });

  test('throws when enabled is not a boolean', () => {
    expect(() => validateAndNormalizeTask({ id: 't1', command: 'update-agents', enabled: 'yes' }, 0, defaults))
      .toThrow('Task t1 has invalid enabled value (must be boolean)');
  });

  test('applies defaults for enabled and schedule when omitted', () => {
    const result = validateAndNormalizeTask({ id: 't1', command: 'update-agents' }, 0, defaults);
    expect(result.id).toBe('t1');
    expect(result.command).toBe('update-agents');
    expect(result.enabled).toBe(true);
    expect(result.schedule).toBe('0 0 * * 0');
  });

  test('uses task name when provided, otherwise falls back to id', () => {
    expect(validateAndNormalizeTask({ id: 't1', name: 'Custom', command: 'x' }, 0, defaults).name).toBe('Custom');
    expect(validateAndNormalizeTask({ id: 't1', command: 'x' }, 0, defaults).name).toBe('t1');
  });

  test('respects task-level enabled and schedule overrides', () => {
    const result = validateAndNormalizeTask(
      { id: 't1', command: 'update-agents', enabled: false, schedule: '0 0 1 * *' },
      0,
      defaults,
    );
    expect(result.enabled).toBe(false);
    expect(result.schedule).toBe('0 0 1 * *');
  });

  test('merges task config over defaults', () => {
    const result = validateAndNormalizeTask(
      { id: 't1', command: 'update-agents', config: { branch: 'develop', files: ['AGENTS.md'] } },
      0,
      defaults,
    );
    expect(result.config.branch).toBe('develop');
    expect(result.config.files).toEqual(['AGENTS.md']);
    expect(result.config.schedule).toBe('0 0 * * 0'); // inherited default
  });

  test('throws for non-string config branch', () => {
    expect(() => validateAndNormalizeTask({ id: 't1', command: 'x', config: { branch: 7 } }, 0, defaults))
      .toThrow('Task t1 has invalid branch value');
  });

  test('throws for non-string config gist_url', () => {
    expect(() => validateAndNormalizeTask({ id: 't1', command: 'x', config: { gist_url: 1 } }, 0, defaults))
      .toThrow('Task t1 has invalid gist_url value');
  });

  test('throws for non-array config files', () => {
    expect(() => validateAndNormalizeTask({ id: 't1', command: 'x', config: { files: 'nope' } }, 0, defaults))
      .toThrow('Task t1 has invalid files value (must be array)');
  });
});

describe('validateAndNormalizeConfig', () => {
  function baseConfig(overrides = {}) {
    return {
      version: 1,
      defaults: { branch: 'main' },
      tasks: [{ id: 't1', command: 'update-agents' }],
      ...overrides,
    };
  }

  test('throws when version is missing', () => {
    expect(() => validateAndNormalizeConfig({ tasks: [] })).toThrow('Configuration missing required field: version');
  });

  test('throws when version is unsupported', () => {
    expect(() => validateAndNormalizeConfig({ version: 2, tasks: [] })).toThrow('Unsupported config version: 2. Expected: 1');
  });

  test('throws when tasks is not an array', () => {
    expect(() => validateAndNormalizeConfig({ version: 1 })).toThrow('Configuration must contain a "tasks" array');
    expect(() => validateAndNormalizeConfig({ version: 1, tasks: {} })).toThrow('Configuration must contain a "tasks" array');
  });

  test('normalizes a valid config and applies defaults', () => {
    const config = validateAndNormalizeConfig(baseConfig());
    expect(config.defaults.branch).toBe('main');
    expect(config.defaults.enabled).toBe(true); // injected default
    expect(config.tasks[0].id).toBe('t1');
    expect(config.tasks[0].enabled).toBe(true);
  });

  test('returns the same config object reference', () => {
    const input = baseConfig();
    expect(validateAndNormalizeConfig(input)).toBe(input);
  });
});

describe('getTasksToRun', () => {
  function config(tasks, defaultsSchedule = '0 0 * * 0') {
    return { defaults: { schedule: defaultsSchedule }, tasks };
  }

  test('returns only enabled tasks', () => {
    const cfg = config([
      { id: 'a', command: 'x', enabled: true },
      { id: 'b', command: 'x', enabled: false },
    ]);
    expect(getTasksToRun(cfg, null).map(t => t.id)).toEqual(['a']);
  });

  test('returns empty array when no tasks are enabled', () => {
    const cfg = config([{ id: 'a', command: 'x', enabled: false }]);
    expect(getTasksToRun(cfg, null)).toEqual([]);
  });

  test('runs all enabled tasks when no event schedule is given', () => {
    const cfg = config([
      { id: 'a', command: 'x', enabled: true, schedule: '0 0 * * 0' },
      { id: 'b', command: 'x', enabled: true, schedule: '0 0 1 * *' },
    ]);
    expect(getTasksToRun(cfg, null).map(t => t.id)).toEqual(['a', 'b']);
  });

  test('runs tasks matching the event schedule OR the defaults schedule', () => {
    // defaults.schedule = '0 0 * * 0'
    const cfg = config([
      { id: 'a', command: 'x', enabled: true, schedule: '0 0 1 * *' }, // matches eventSchedule
      { id: 'b', command: 'x', enabled: true, schedule: '0 0 * * 0' }, // matches defaults.schedule
      { id: 'c', command: 'x', enabled: true, schedule: '30 5 * * *' }, // matches neither
    ]);
    // eventSchedule = '0 0 1 * *' -> runs a (event match) + b (defaults match), excludes c
    expect(getTasksToRun(cfg, '0 0 1 * *').map(t => t.id)).toEqual(['a', 'b']);
  });

  test('excludes tasks whose schedule matches neither event nor defaults', () => {
    const cfg = config([
      { id: 'c', command: 'x', enabled: true, schedule: '30 5 * * *' },
    ]);
    expect(getTasksToRun(cfg, '0 0 1 * *')).toEqual([]);
  });

  test('matches tasks whose schedule equals the defaults schedule', () => {
    const cfg = config([
      { id: 'a', command: 'x', enabled: true, schedule: '0 0 * * 0' },
      { id: 'b', command: 'x', enabled: true, schedule: '0 0 1 * *' },
    ]);
    expect(getTasksToRun(cfg, '0 0 * * 0').map(t => t.id)).toEqual(['a']);
  });
});

describe('getTaskById', () => {
  const cfg = { tasks: [{ id: 'a' }, { id: 'b' }] };

  test('returns the matching task', () => {
    expect(getTaskById(cfg, 'b').id).toBe('b');
  });

  test('returns null when not found', () => {
    expect(getTaskById(cfg, 'missing')).toBe(null);
  });
});

describe('loadScheduledConfig', () => {
  const prevPath = process.env.ZAI_SCHEDULED_CONFIG_PATH;

  afterEach(() => {
    if (prevPath === undefined) delete process.env.ZAI_SCHEDULED_CONFIG_PATH;
    else process.env.ZAI_SCHEDULED_CONFIG_PATH = prevPath;
  });

  test('fetches, parses, and validates config via octokit', async () => {
    const raw = yaml.stringify({
      version: 1,
      defaults: { branch: 'main' },
      tasks: [{ id: 'weekly', command: 'update-agents' }],
    });
    let calledPath;
    let calledRef;
    const octokit = buildOctokit({
      getContent: async ({ path, ref }) => {
        calledPath = path;
        calledRef = ref;
        return contentResponse(raw);
      },
    });

    const config = await loadScheduledConfig(octokit, 'owner', 'repo', 'develop');

    expect(calledPath).toBe('.zai-scheduled.yml');
    expect(calledRef).toBe('develop');
    expect(config.version).toBe(1);
    expect(config.tasks[0].id).toBe('weekly');
  });

  test('uses ZAI_SCHEDULED_CONFIG_PATH when set', async () => {
    process.env.ZAI_SCHEDULED_CONFIG_PATH = '.custom.yml';
    const octokit = buildOctokit({
      getContent: async ({ path }) => {
        expect(path).toBe('.custom.yml');
        return contentResponse(yaml.stringify({ version: 1, tasks: [] }));
      },
    });
    await loadScheduledConfig(octokit, 'owner', 'repo');
  });

  test('defaults ref to main', async () => {
    let calledRef;
    const octokit = buildOctokit({
      getContent: async ({ ref }) => {
        calledRef = ref;
        return contentResponse(yaml.stringify({ version: 1, tasks: [] }));
      },
    });
    await loadScheduledConfig(octokit, 'owner', 'repo');
    expect(calledRef).toBe('main');
  });

  test('returns null on 404 (config not found)', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    const octokit = buildOctokit({ getContent: async () => { throw err; } });
    expect(await loadScheduledConfig(octokit, 'owner', 'repo')).toBe(null);
  });

  test('rethrows non-404 errors', async () => {
    const err = Object.assign(new Error('Server error'), { status: 500 });
    const octokit = buildOctokit({ getContent: async () => { throw err; } });
    await expect(loadScheduledConfig(octokit, 'owner', 'repo')).rejects.toThrow('Server error');
  });

  test('rethrows validation errors from upstream', async () => {
    const octokit = buildOctokit({
      getContent: async () => contentResponse(yaml.stringify({ tasks: [] })), // missing version
    });
    await expect(loadScheduledConfig(octokit, 'owner', 'repo')).rejects.toThrow('Configuration missing required field: version');
  });
});

describe('areScheduledTasksEnabled', () => {
  test('returns true when config is found', async () => {
    const octokit = buildOctokit({
      getContent: async () => contentResponse(yaml.stringify({ version: 1, tasks: [] })),
    });
    expect(await areScheduledTasksEnabled(octokit, 'owner', 'repo')).toBe(true);
  });

  test('returns false when config is not found (404)', async () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    const octokit = buildOctokit({ getContent: async () => { throw err; } });
    expect(await areScheduledTasksEnabled(octokit, 'owner', 'repo')).toBe(false);
  });
});
