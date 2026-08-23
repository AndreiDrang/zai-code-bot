import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../shared/github.js';

describe('GitHub comment storage API', () => {
  let client;
  let fetchSpy;

  beforeEach(() => {
    client = new GitHubClient('token');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  });

  afterEach(() => vi.restoreAllMocks());

  it('lists issue comments with pagination', async () => {
    await client.getIssueComments('o', 'r', 7, 2, 50);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/o/r/issues/7/comments?page=2&per_page=50',
    );
  });

  it('updates a comment using the GitHub issue comment endpoint', async () => {
    await client.updateComment('o', 'r', 99, 'updated');
    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/o/r/issues/comments/99');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ body: 'updated' });
  });
});
