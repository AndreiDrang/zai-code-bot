import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeCommenter, isAuthorized } from '../shared/auth.js';

describe('shared/auth', () => {
  describe('authorizeCommenter', () => {
    it('returns true when the collaborator check succeeds (204, no body)', async () => {
      const github = { request: vi.fn().mockResolvedValue(null) };
      expect(await authorizeCommenter(github, 'o', 'r', 'u')).toBe(true);
      expect(github.request).toHaveBeenCalledWith('GET', '/repos/o/r/collaborators/u');
    });

    it('returns false on a 404 (not a collaborator)', async () => {
      const notFound = Object.assign(new Error('not found'), { status: 404 });
      const github = { request: vi.fn().mockRejectedValue(notFound) };
      expect(await authorizeCommenter(github, 'o', 'r', 'u')).toBe(false);
    });

    it('rethrows a non-404 status error (e.g. 500)', async () => {
      const serverError = Object.assign(new Error('boom'), { status: 500 });
      const github = { request: vi.fn().mockRejectedValue(serverError) };
      await expect(authorizeCommenter(github, 'o', 'r', 'u')).rejects.toBe(serverError);
    });

    it('rethrows errors that carry no status (e.g. network failure)', async () => {
      const github = { request: vi.fn().mockRejectedValue(new Error('network down')) };
      await expect(authorizeCommenter(github, 'o', 'r', 'u')).rejects.toThrow('network down');
    });
  });

  describe('isAuthorized', () => {
    let fetchSpy;
    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, 'fetch');
    });
    afterEach(() => vi.restoreAllMocks());

    it('builds a client from env.GITHUB_TOKEN and authorizes a collaborator', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      expect(await isAuthorized({ GITHUB_TOKEN: 'tok' }, 'o', 'r', 'u')).toBe(true);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.github.com/repos/o/r/collaborators/u');
      expect(opts.headers.Authorization).toBe('token tok');
    });

    it('returns false for a non-collaborator', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('nf', { status: 404 }));
      expect(await isAuthorized({ GITHUB_TOKEN: 'tok' }, 'o', 'r', 'u')).toBe(false);
    });

    it('resolves a Secrets-Store binding shape (object.get()) for the token', async () => {
      fetchSpy.mockResolvedValueOnce(new Response(null, { status: 204 }));
      const env = { GITHUB_TOKEN: { get: async () => 'tok-from-binding' } };
      expect(await isAuthorized(env, 'o', 'r', 'u')).toBe(true);
      expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('token tok-from-binding');
    });
  });
});
