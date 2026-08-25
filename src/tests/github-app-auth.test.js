/**
 * Tests for the GitHub App authentication module.
 *
 * JWT tests use a REAL RSA keypair generated per run (node:crypto) and verify
 * the RS256 signature with Web Crypto — no fixtures, no fabricated base64.
 * The token-endpoint and provider tests mock global fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  AppTokenCache,
  createTokenProvider,
  fetchInstallationToken,
  generateAppJwt,
} from '../shared/github-app-auth.js';

// --- real keypair -----------------------------------------------------------

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_KEY_SPKI = publicKey.export({ type: 'spki', format: 'der' });

const TEST_APP_ID = '123456';
const TEST_INSTALLATION_ID = '789012';

/** Imports the test public key for crypto.subtle.verify. */
async function importVerifyKey() {
  return crypto.subtle.importKey(
    'spki',
    PUBLIC_KEY_SPKI,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/** Decodes a base64url JWT part to a UTF-8 string. */
function decodePart(part) {
  return Buffer.from(part, 'base64url').toString('utf8');
}

/** Builds a mock fetch Response carrying JSON. */
function jsonResponse(status, body) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// generateAppJwt
// ---------------------------------------------------------------------------

describe('generateAppJwt', () => {
  it('generates a JWT with three base64url parts', async () => {
    const jwt = await generateAppJwt(TEST_APP_ID, TEST_PRIVATE_KEY);

    expect(typeof jwt).toBe('string');
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('signs a verifiable RS256 signature over header.payload', async () => {
    const jwt = await generateAppJwt(TEST_APP_ID, TEST_PRIVATE_KEY);
    const [header, payload, signature] = jwt.split('.');

    const verifyKey = await importVerifyKey();
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      verifyKey,
      Uint8Array.from(Buffer.from(signature, 'base64url')),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it('uses the RS256 header and the app id as issuer with a 9-minute lifetime', async () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = await generateAppJwt(TEST_APP_ID, TEST_PRIVATE_KEY);
    const after = Math.floor(Date.now() / 1000);

    const [header, payload] = jwt.split('.').map(decodePart);
    expect(JSON.parse(header)).toEqual({ alg: 'RS256', typ: 'JWT' });

    const claims = JSON.parse(payload);
    expect(claims.iss).toBe(TEST_APP_ID);
    expect(claims.exp - claims.iat).toBe(540);
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(claims.iat).toBeLessThanOrEqual(after);
  });

  it('tolerates PEM keys with CRLF line endings, blank lines, and surrounding whitespace', async () => {
    const mangled = `\r\n\r\n   ${TEST_PRIVATE_KEY.replace(/\n/g, '\r\n').replace(
      /-----END PRIVATE KEY-----/,
      '\n\n-----END PRIVATE KEY-----   \n',
    )}`;

    const jwt = await generateAppJwt(TEST_APP_ID, mangled);
    const [header, payload, signature] = jwt.split('.');

    const verifyKey = await importVerifyKey();
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      verifyKey,
      Uint8Array.from(Buffer.from(signature, 'base64url')),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchInstallationToken
// ---------------------------------------------------------------------------

describe('fetchInstallationToken', () => {
  let fetchSpy;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the token endpoint with JWT bearer auth and returns the token', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(201, { token: 'ghs_1234567890abcdef' }));

    const token = await fetchInstallationToken('test-jwt', TEST_INSTALLATION_ID);

    expect(token).toBe('ghs_1234567890abcdef');
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.github.com/app/installations/789012/access_tokens');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-jwt');
    expect(opts.headers.Accept).toBe('application/vnd.github+json');
    expect(opts.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(opts.headers['User-Agent']).toBe('zai-code-bot-workers');
  });

  it.each([
    [401, 'app_jwt_rejected'],
    [403, 'app_suspended'],
    [404, 'installation_not_found'],
  ])('maps HTTP %i to a non-retryable %s error', async (status, code) => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(status, { message: 'nope' }));

    const error = await fetchInstallationToken('test-jwt', TEST_INSTALLATION_ID).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(status);
    // Raw provider bodies must not ride along on the error.
    expect(error.body).toBeUndefined();
    expect(error.message).not.toContain('nope');
  });

  it.each([
    [429, 'app_token_fetch_failed'],
    [500, 'app_token_fetch_failed'],
    [503, 'app_token_fetch_failed'],
  ])('maps HTTP %i to a retryable %s error', async (status, code) => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status }));

    const error = await fetchInstallationToken('test-jwt', TEST_INSTALLATION_ID).catch((e) => e);

    expect(error.code).toBe(code);
    expect(error.retryable).toBe(true);
  });

  it('maps a network failure to a retryable app_token_fetch_failed error', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

    const error = await fetchInstallationToken('test-jwt', TEST_INSTALLATION_ID).catch((e) => e);

    expect(error.code).toBe('app_token_fetch_failed');
    expect(error.retryable).toBe(true);
  });

  it('rejects a 2xx response that carries no token', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(201, {}));

    const error = await fetchInstallationToken('test-jwt', TEST_INSTALLATION_ID).catch((e) => e);

    expect(error.code).toBe('app_token_fetch_failed');
    expect(error.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AppTokenCache
// ---------------------------------------------------------------------------

describe('AppTokenCache', () => {
  let mockKv;
  let cache;

  beforeEach(() => {
    mockKv = {
      get: vi.fn(),
      put: vi.fn(),
    };
    cache = new AppTokenCache(mockKv, 300);
  });

  it('returns null when the cache is empty', async () => {
    mockKv.get.mockResolvedValueOnce({ value: null });

    expect(await cache.get(TEST_INSTALLATION_ID)).toBeNull();
  });

  it('returns the cached token when available', async () => {
    mockKv.get.mockResolvedValueOnce({ value: 'ghs_cached_token' });

    expect(await cache.get(TEST_INSTALLATION_ID)).toBe('ghs_cached_token');
  });

  it('swallows KV read errors as cache misses', async () => {
    mockKv.get.mockRejectedValueOnce(new Error('KV error'));

    expect(await cache.get(TEST_INSTALLATION_ID)).toBeNull();
  });

  it('writes the token with the configured TTL', async () => {
    await cache.set(TEST_INSTALLATION_ID, 'ghs_new_token');

    expect(mockKv.put).toHaveBeenCalledWith(
      `installation_token:${TEST_INSTALLATION_ID}`,
      JSON.stringify({ value: 'ghs_new_token' }),
      { expirationTtl: 300 },
    );
  });

  it('swallows KV write errors', async () => {
    mockKv.put.mockRejectedValueOnce(new Error('KV error'));

    await expect(cache.set(TEST_INSTALLATION_ID, 'ghs_new_token')).resolves.toBeUndefined();
  });

  it('degrades to no-ops when constructed without a namespace', async () => {
    const bare = new AppTokenCache(null);
    await expect(bare.get(TEST_INSTALLATION_ID)).resolves.toBeNull();
    await expect(bare.set(TEST_INSTALLATION_ID, 'x')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createTokenProvider
// ---------------------------------------------------------------------------

describe('createTokenProvider', () => {
  let fetchSpy;
  let mockKv;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    mockKv = { get: vi.fn().mockResolvedValue({ value: null }), put: vi.fn() };
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['plain strings', { GITHUB_APP_ID: TEST_APP_ID, GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY }],
    [
      'object {get()} bindings',
      {
        GITHUB_APP_ID: { get: async () => TEST_APP_ID },
        GITHUB_APP_PRIVATE_KEY: { get: async () => TEST_PRIVATE_KEY },
      },
    ],
    [
      'Promise bindings',
      {
        GITHUB_APP_ID: Promise.resolve(TEST_APP_ID),
        GITHUB_APP_PRIVATE_KEY: Promise.resolve(TEST_PRIVATE_KEY),
      },
    ],
  ])('resolves %s and reports the provider as available', async (_label, env) => {
    const provider = await createTokenProvider(env);
    expect(provider.available).toBe(true);
  });

  it.each([
    ['missing app id', { GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY }],
    ['missing private key', { GITHUB_APP_ID: TEST_APP_ID }],
    ['blank app id', { GITHUB_APP_ID: '  ', GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY }],
    ['empty bindings', {}],
  ])('reports unavailable for %s', async (_label, env) => {
    const provider = await createTokenProvider(env);
    expect(provider.available).toBe(false);
  });

  it('mints and caches a token on cache miss', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(201, { token: 'ghs_fresh' }));

    const provider = await createTokenProvider({
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
      BOT_CACHE: mockKv,
    });
    const token = await provider.getInstallationToken(TEST_INSTALLATION_ID);

    expect(token).toBe('ghs_fresh');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(mockKv.put).toHaveBeenCalledWith(
      `installation_token:${TEST_INSTALLATION_ID}`,
      JSON.stringify({ value: 'ghs_fresh' }),
      expect.objectContaining({ expirationTtl: 300 }),
    );
  });

  it('serves a cache hit without minting', async () => {
    mockKv.get.mockResolvedValueOnce({ value: 'ghs_cached' });

    const provider = await createTokenProvider({
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
      BOT_CACHE: mockKv,
    });
    const token = await provider.getInstallationToken(TEST_INSTALLATION_ID);

    expect(token).toBe('ghs_cached');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockKv.put).not.toHaveBeenCalled();
  });

  it('propagates a classified mint failure (404 → installation_not_found)', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(404, { message: 'gone' }));

    const provider = await createTokenProvider({
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
      BOT_CACHE: mockKv,
    });
    const error = await provider.getInstallationToken(TEST_INSTALLATION_ID).catch((e) => e);

    expect(error.code).toBe('installation_not_found');
    expect(error.retryable).toBe(false);
    expect(mockKv.put).not.toHaveBeenCalled();
  });

  it('throws non-retryable app_auth_unconfigured on mint when secrets are missing', async () => {
    const provider = await createTokenProvider({});
    const error = await provider.getInstallationToken(TEST_INSTALLATION_ID).catch((e) => e);

    expect(error.code).toBe('app_auth_unconfigured');
    expect(error.retryable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws non-retryable missing_installation_id when no installation is given', async () => {
    const provider = await createTokenProvider({
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
    });
    const error = await provider.getInstallationToken(undefined).catch((e) => e);

    expect(error.code).toBe('missing_installation_id');
    expect(error.retryable).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
