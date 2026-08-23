import { describe, expect, it, vi } from 'vitest';
import {
  createContextToolRegistry,
  executeContextTool,
  getContextToolDefinitions,
  toOpenAiToolDefinitions,
} from '../shared/context-tools/registry.js';

describe('Context Tools', () => {
  it('exposes provider-agnostic schemas', () => {
    expect(getContextToolDefinitions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'list_changed_files' }),
        expect.objectContaining({ name: 'get_diff' }),
        expect.objectContaining({ name: 'get_file' }),
        expect.objectContaining({ name: 'get_file_range' }),
        expect.objectContaining({ name: 'get_description' }),
        expect.objectContaining({ name: 'get_commits' }),
        expect.objectContaining({ name: 'get_comments' }),
      ]),
    );
  });

  it('describes semantic tool use without exposing storage implementation', () => {
    const definitions = getContextToolDefinitions();
    const diff = definitions.find((tool) => tool.name === 'get_diff');
    const file = definitions.find((tool) => tool.name === 'get_file');
    const range = definitions.find((tool) => tool.name === 'get_file_range');

    expect(diff.description).toContain('changed by this pull request');
    expect(diff.description).toContain('Do not use it for unchanged files');
    expect(diff.description).toContain('highest-risk changed files first');
    expect(diff.description).toContain('Do not repeat an identical request');
    expect(file.description).toContain('Prefer get_file_range');
    expect(range.input_schema.properties.startLine.description).toContain('1-based inclusive');
    expect(JSON.stringify(definitions)).not.toMatch(/\b(R2|D1|KV|storage key)\b/i);
  });

  it('delegates tools to Context Service without an R2 binding', async () => {
    const context = {
      listChangedFiles: vi.fn().mockResolvedValue({ status: 'available', files: [] }),
      getDiff: vi.fn().mockResolvedValue({ status: 'available', diff: '@@ patch' }),
      getFile: vi.fn().mockResolvedValue({ status: 'available', content: 'source' }),
      getFileRange: vi.fn().mockResolvedValue({ status: 'available', content: '1 | source' }),
      getDescription: vi.fn().mockResolvedValue({ status: 'available', body: 'description' }),
      getCommits: vi.fn().mockResolvedValue({ status: 'available', commits: [] }),
      getComments: vi.fn().mockResolvedValue({ status: 'available', comments: [] }),
    };

    await expect(executeContextTool('list_changed_files', {}, context)).resolves.toMatchObject({
      status: 'available',
    });
    await expect(
      executeContextTool('get_diff', { path: 'src/cache.ts' }, context),
    ).resolves.toMatchObject({
      diff: '@@ patch',
    });
    expect(context.getDiff).toHaveBeenCalledWith('src/cache.ts');
    await expect(
      executeContextTool('get_file', { path: 'src/cache.ts' }, context),
    ).resolves.toMatchObject({
      content: 'source',
    });
    await expect(
      executeContextTool(
        'get_file_range',
        {
          path: 'src/cache.ts',
          startLine: 1,
          endLine: 1,
        },
        context,
      ),
    ).resolves.toMatchObject({ content: '1 | source' });
    await expect(executeContextTool('get_description', {}, context)).resolves.toMatchObject({
      body: 'description',
    });
    await expect(executeContextTool('get_commits', { limit: 10 }, context)).resolves.toMatchObject({
      commits: [],
    });
    await expect(
      executeContextTool('get_comments', { path: 'src/cache.ts' }, context),
    ).resolves.toMatchObject({
      comments: [],
    });
  });

  it('rejects unknown and malformed arguments before invoking a handler', async () => {
    const context = { getDiff: vi.fn() };

    await expect(executeContextTool('get_diff', {}, context)).rejects.toThrow(
      'Missing argument for get_diff: path',
    );
    await expect(
      executeContextTool('get_diff', { path: 'src/cache.ts', extra: true }, context),
    ).rejects.toThrow('Unknown argument for get_diff: extra');
  });

  it('binds a Context Service once and adapts schemas for the Z.ai tool protocol', async () => {
    const context = { getDescription: vi.fn().mockResolvedValue({ body: 'description' }) };
    const registry = createContextToolRegistry(context);

    await expect(registry.execute('get_description', {})).resolves.toEqual({ body: 'description' });
    expect(toOpenAiToolDefinitions(registry.getDefinitions())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({
            name: 'get_diff',
            parameters: expect.objectContaining({ type: 'object' }),
          }),
        }),
      ]),
    );
  });
});

describe('Context Tool argument validation', () => {
  const context = { getDiff: vi.fn() };

  it('rejects an undeclared tool name before touching the context', async () => {
    await expect(executeContextTool('get_magic', {}, context)).rejects.toThrow(
      'Unknown context tool: get_magic',
    );
    expect(context.getDiff).not.toHaveBeenCalled();
  });

  it('rejects non-object argument bags', async () => {
    await expect(executeContextTool('get_diff', null, context)).rejects.toThrow(
      'Arguments for get_diff must be an object',
    );
    await expect(executeContextTool('get_diff', undefined, context)).rejects.toThrow(
      'Arguments for get_diff must be an object',
    );
    await expect(executeContextTool('get_diff', ['src/cache.ts'], context)).rejects.toThrow(
      'Arguments for get_diff must be an object',
    );
    await expect(executeContextTool('get_diff', 'src/cache.ts', context)).rejects.toThrow(
      'Arguments for get_diff must be an object',
    );
  });

  it('type-checks declared string and integer arguments', async () => {
    await expect(executeContextTool('get_diff', { path: 42 }, context)).rejects.toThrow(
      'path for get_diff must be a string',
    );
    await expect(executeContextTool('get_commits', { limit: 'many' }, context)).rejects.toThrow(
      'limit for get_commits must be a positive integer',
    );
    await expect(executeContextTool('get_commits', { limit: 0 }, context)).rejects.toThrow(
      'limit for get_commits must be a positive integer',
    );
  });

  it('accepts a valid optional integer and skips absent properties', async () => {
    const ok = { getCommits: vi.fn().mockResolvedValue({ commits: [] }) };
    await expect(executeContextTool('get_commits', { limit: 5 }, ok)).resolves.toEqual({
      commits: [],
    });
  });
});
