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
