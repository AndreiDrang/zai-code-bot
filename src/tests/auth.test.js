import { describe, expect, it, vi } from 'vitest';
import { authorizeCommenter } from '../shared/auth.js';

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

    it('maps a 403 to a non-retryable app_permission_missing error', async () => {
      // An installation token without "Collaborators: read-only" gets 403 —
      // this must surface as a loud config error, never as "not authorized".
      const forbidden = Object.assign(new Error('Resource not accessible by integration'), {
        status: 403,
      });
      const github = { request: vi.fn().mockRejectedValue(forbidden) };

      const error = await authorizeCommenter(github, 'o', 'r', 'u').catch((e) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('app_permission_missing');
      expect(error.retryable).toBe(false);
      expect(error.message).toContain('Collaborators');
    });

    it('rethrows a non-404/403 status error (e.g. 500)', async () => {
      const serverError = Object.assign(new Error('boom'), { status: 500 });
      const github = { request: vi.fn().mockRejectedValue(serverError) };
      await expect(authorizeCommenter(github, 'o', 'r', 'u')).rejects.toBe(serverError);
    });

    it('rethrows errors that carry no status (e.g. network failure)', async () => {
      const github = { request: vi.fn().mockRejectedValue(new Error('network down')) };
      await expect(authorizeCommenter(github, 'o', 'r', 'u')).rejects.toThrow('network down');
    });
  });
});
