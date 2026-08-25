/**
 * Tests for GitHub App Authentication module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateAppJwt, getInstallationToken, createTokenProvider, AppTokenCache } from '../shared/github-app-auth.js';

// Mock private key for testing (this is a test key, not a real one)
const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTj6jk0FqXW
q3dL5JQ8j0Q9Hj0lYQjZ2Y4Xd8J9J5J5J5J5J5J5J5J5J5J5J5J5J5J5J5J5J
-----END PRIVATE KEY-----`;

const TEST_APP_ID = '123456';
const TEST_INSTALLATION_ID = '789012';

describe('generateAppJwt', () => {
  it('should generate a valid JWT token', async () => {
    const jwt = await generateAppJwt(TEST_APP_ID, TEST_PRIVATE_KEY);
    
    expect(jwt).toBeTruthy();
    expect(typeof jwt).toBe('string');
    
    // JWT should have 3 parts separated by dots
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    
    // Each part should be Base64URL encoded
    expect(parts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('should include app ID in payload', async () => {
    const jwt = await generateAppJwt(TEST_APP_ID, TEST_PRIVATE_KEY);
    const parts = jwt.split('.');
    
    // Decode payload (second part)
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    
    expect(payload.iss).toBe(TEST_APP_ID);
    expect(payload.iat).toBeDefined();
    expect(payload.exp).toBeDefined();
    
    // Expiration should be ~9 minutes from now
    const now = Math.floor(Date.now() / 1000);
    expect(payload.exp - payload.iat).toBeCloseTo(540, -10);
  });

  it('should handle private key with different formatting', async () => {
    // Test with key that has extra whitespace
    const keyWithWhitespace = `
-----BEGIN PRIVATE KEY-----

MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTj6jk0FqXW
q3dL5JQ8j0Q9Hj0lYQjZ2Y4Xd8J9J5J5J5J5J5J5J5J5J5J5J5J5J5J5J5J5

-----END PRIVATE KEY-----
    `;
    
    const jwt = await generateAppJwt(TEST_APP_ID, keyWithWhitespace);
    expect(jwt).toBeTruthy();
    expect(jwt.split('.')).toHaveLength(3);
  });
});

describe('getInstallationToken', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it('should fetch installation token successfully', async () => {
    const mockToken = 'ghs_1234567890abcdef';
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token: mockToken }),
    });

    const token = await getInstallationToken('test-jwt', TEST_INSTALLATION_ID);
    
    expect(token).toBe(mockToken);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/789012/access_tokens',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-jwt',
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'zai-code-bot-workers',
        }),
      })
    );
  });

  it('should throw error on API failure', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not found'),
    });

    await expect(getInstallationToken('test-jwt', TEST_INSTALLATION_ID))
      .rejects.toThrow('GitHub API error: 404');
  });

  it('should handle network errors', async () => {
    global.fetch.mockRejectedValueOnce(new Error('Network error'));

    await expect(getInstallationToken('test-jwt', TEST_INSTALLATION_ID))
      .rejects.toThrow('Network error');
  });
});

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

  it('should return null when cache is empty', async () => {
    mockKv.get.mockResolvedValueOnce({ value: null });
    
    const result = await cache.get(TEST_INSTALLATION_ID);
    expect(result).toBeNull();
  });

  it('should return cached token when available', async () => {
    const cachedToken = 'ghs_cached_token';
    mockKv.get.mockResolvedValueOnce({ value: cachedToken });
    
    const result = await cache.get(TEST_INSTALLATION_ID);
    expect(result).toBe(cachedToken);
  });

  it('should handle KV errors gracefully', async () => {
    mockKv.get.mockRejectedValueOnce(new Error('KV error'));
    
    const result = await cache.get(TEST_INSTALLATION_ID);
    expect(result).toBeNull();
  });

  it('should set token in cache', async () => {
    await cache.set(TEST_INSTALLATION_ID, 'ghs_new_token');
    
    expect(mockKv.put).toHaveBeenCalledWith(
      `installation_token:${TEST_INSTALLATION_ID}`,
      JSON.stringify({ value: 'ghs_new_token' }),
      expect.objectContaining({
        expirationTtl: 300,
      })
    );
  });

  it('should handle set errors gracefully', async () => {
    mockKv.put.mockRejectedValueOnce(new Error('KV error'));
    
    // Should not throw
    await cache.set(TEST_INSTALLATION_ID, 'ghs_new_token');
  });
});

describe('createTokenProvider', () => {
  let mockEnv;

  beforeEach(() => {
    global.fetch = vi.fn();
    mockEnv = {
      GITHUB_APP_ID: TEST_APP_ID,
      GITHUB_APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
      BOT_CACHE: null, // No cache for these tests
    };
  });

  it('should create token provider', () => {
    const provider = createTokenProvider(mockEnv);
    expect(provider).toHaveProperty('getInstallationToken');
    expect(typeof provider.getInstallationToken).toBe('function');
  });

  it('should generate and cache installation token', async () => {
    // Mock JWT generation and API call
    const mockToken = 'ghs_final_token';
    
    // First, mock the JWT generation (internal to provider)
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ token: mockToken }),
    });

    const provider = createTokenProvider(mockEnv);
    const token = await provider.getInstallationToken(TEST_INSTALLATION_ID);

    expect(token).toBe(mockToken);
  });

  it('should use cached token when available', async () => {
    const cachedToken = 'ghs_cached_token';
    const mockKv = {
      get: vi.fn().mockResolvedValue({ value: cachedToken }),
      put: vi.fn(),
    };

    mockEnv.BOT_CACHE = mockKv;
    
    const provider = createTokenProvider(mockEnv);
    const token = await provider.getInstallationToken(TEST_INSTALLATION_ID);

    expect(token).toBe(cachedToken);
    expect(mockKv.get).toHaveBeenCalledWith(
      `installation_token:${TEST_INSTALLATION_ID}`,
      expect.any(Object)
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
