import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../shared/github.js';

describe('shared/github (GitHubClient)', () => {
  let client;
  let fetchSpy;

  beforeEach(() => {
    client = new GitHubClient('mock-token');
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('stores the token, default base URL, and user-agent', () => {
      expect(client.token).toBe('mock-token');
      expect(client.baseUrl).toBe('https://api.github.com');
      expect(client.userAgent).toBe('zai-code-bot-workers');
    });

    it('honors a custom userAgent option', () => {
      expect(new GitHubClient('t', { userAgent: 'custom-ua' }).userAgent).toBe('custom-ua');
    });
  });

  describe('request — success paths', () => {
    it('parses a JSON body on 200', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      expect((await client.request('GET', '/x')).ok).toBe(true);
    });

    it('returns null on 204 No Content (empty body, no JSON parse error)', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      expect(await client.request('GET', '/repos/o/r/collaborators/u')).toBeNull();
    });

    it('returns the raw body when opts.returnText is set', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('raw diff', { status: 200 }));
      expect(await client.request('GET', '/x', null, { returnText: true })).toBe('raw diff');
    });

    it('overrides the Accept header when opts.accept is provided', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('raw', { status: 200 }));
      await client.request('GET', '/x', null, {
        accept: 'application/vnd.github.raw',
        returnText: true,
      });
      expect(fetchSpy.mock.calls[0][1].headers.Accept).toBe('application/vnd.github.raw');
    });

    it('sends the full header set (auth, accept, api-version, ua)', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await client.request('GET', '/x');
      const headers = fetchSpy.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe('token mock-token');
      expect(headers.Accept).toBe('application/vnd.github+json');
      expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
      expect(headers['User-Agent']).toBe('zai-code-bot-workers');
    });

    it('JSON-stringifies the body and sets the method on writes', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ id: 1 }), { status: 201 }));
      await client.request('POST', '/x', { body: 'hi' });
      const opts = fetchSpy.mock.calls[0][1];
      expect(opts.method).toBe('POST');
      expect(opts.body).toBe(JSON.stringify({ body: 'hi' }));
    });
  });

  describe('request — error paths', () => {
    it('throws with error.status on a non-ok response', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('nope', { status: 404 }));
      await expect(client.request('GET', '/x')).rejects.toMatchObject({
        status: 404,
        message: expect.stringContaining('404'),
      });
    });

    it('preserves the response body preview on error', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
      try {
        await client.request('GET', '/x');
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e.status).toBe(404);
        expect(e.body).toBe('Not Found');
      }
    });

    it('wraps a non-JSON 2xx body in an error that keeps error.status', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('<<not json>>', { status: 200, headers: { 'content-type': 'text/plain' } }),
      );
      try {
        await client.request('GET', '/x');
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e.status).toBe(200);
        expect(e.body).toBe('<<not json>>');
      }
    });
  });

  describe('convenience methods build the expected paths', () => {
    beforeEach(() => {
      // Default stub for every request: 204 / empty body -> null.
      fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    });

    it('getRepository / getIssue / getPullRequest / getUser', async () => {
      await client.getRepository('o', 'r');
      await client.getIssue('o', 'r', 9);
      await client.getPullRequest('o', 'r', 7);
      await client.getUser('u');
      const urls = fetchSpy.mock.calls.map((c) => c[0]);
      expect(urls).toEqual([
        'https://api.github.com/repos/o/r',
        'https://api.github.com/repos/o/r/issues/9',
        'https://api.github.com/repos/o/r/pulls/7',
        'https://api.github.com/users/u',
      ]);
    });

    it('postComment POSTs to the issues-comments endpoint with a body', async () => {
      await client.postComment('o', 'r', 42, 'hello');
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/o/r/issues/42/comments');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body)).toEqual({ body: 'hello' });
    });

    it('getPrFiles forwards pagination query params', async () => {
      await client.getPrFiles('o', 'r', 7, 2, 50);
      const url = fetchSpy.mock.calls[0][0];
      expect(url).toContain('/repos/o/r/pulls/7/files');
      expect(url).toContain('page=2');
      expect(url).toContain('per_page=50');
    });

    it('getFileContent requests raw content and returns text', async () => {
      fetchSpy.mockResolvedValue(new Response('file body', { status: 200 }));
      const result = await client.getFileContent('o', 'r', 'src/a.js', 'abc');
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/o/r/contents/src%2Fa.js?ref=abc');
      expect(opts.headers.Accept).toBe('application/vnd.github.raw');
      expect(result).toBe('file body');
    });

    it('getPrDiff requests the diff media type and returns raw text', async () => {
      fetchSpy.mockResolvedValue(new Response('@@ diff @@', { status: 200 }));
      const result = await client.getPrDiff('o', 'r', 7);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/o/r/pulls/7');
      expect(opts.headers.Accept).toBe('application/vnd.github.v3.diff');
      expect(result).toBe('@@ diff @@');
    });

    it('getPrCommits and getReviewComments build the expected paginated paths', async () => {
      await client.getPrCommits('o', 'r', 7, 2, 50);
      await client.getReviewComments('o', 'r', 7, 3, 25);
      const urls = fetchSpy.mock.calls.map((c) => c[0]);
      expect(urls).toEqual([
        'https://api.github.com/repos/o/r/pulls/7/commits?page=2&per_page=50',
        'https://api.github.com/repos/o/r/pulls/7/comments?page=3&per_page=25',
      ]);
    });

    it('getPrDescription returns the PR body', async () => {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ body: '## hello' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      expect(await client.getPrDescription('o', 'r', 7)).toBe('## hello');
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.github.com/repos/o/r/pulls/7');
    });

    it('getPrComments merges issue and review comments, capped by maxComments', async () => {
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: 1, body: 'issue' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify([{ id: 2, body: 'review' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      const result = await client.getPrComments('o', 'r', 7, { maxComments: 10 });
      expect(result).toEqual({
        issue: [{ id: 1, body: 'issue' }],
        review: [{ id: 2, body: 'review' }],
      });
      const urls = fetchSpy.mock.calls.map((c) => c[0]);
      expect(urls[0]).toContain('/issues/7/comments');
      expect(urls[1]).toContain('/pulls/7/comments');
      expect(urls[0]).toContain('per_page=10');
    });

    it('getPrComments degrades to empty lists when a slice errors', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 500 })).mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 2 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      const result = await client.getPrComments('o', 'r', 7);
      expect(result.issue).toEqual([]);
      expect(result.review).toEqual([{ id: 2 }]);
    });
  });
});
