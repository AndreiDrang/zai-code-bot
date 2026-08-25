/**
 * GitHub App Authentication for Cloudflare Workers.
 * Generates JWT and fetches Installation Access Tokens.
 *
 * This is the ONLY authentication path in the codebase (PAT support removed).
 * Secrets must be resolved through `resolveSecretValue` — Secrets Store
 * bindings can surface as string | {get()} | Promise, and a raw binding
 * stringifies to "[object Object]", silently breaking every token mint.
 */

import { resolveSecretValue } from './secrets.js';

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Creates a classified GitHub App authentication error.
 * `retryable: false` marks config/permanent failures (queue: fail the job,
 * webhook: 503 without pointlessly burning attempts).
 * @param {string} code - Stable error code (e.g. 'app_jwt_rejected')
 * @param {string} message - Short, log-safe message (no raw provider bodies)
 * @param {Object} [opts]
 * @param {boolean} [opts.retryable] - default true
 * @param {number} [opts.status] - HTTP status from GitHub, when applicable
 * @returns {Error}
 */
function appAuthError(code, message, { retryable = true, status } = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  if (status !== undefined) error.status = status;
  return error;
}

/**
 * Encodes bytes to Base64URL format (for JWT parts).
 * @param {Uint8Array} bytes
 * @returns {string} Base64URL encoded string (no padding)
 */
function encodeBase64UrlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Non-PKCS#8 PEM header forms (PKCS#1, SEC1, OpenSSH). */
const NON_PKCS8_HEADER = /-----BEGIN (?:RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/;

/**
 * Validates and imports the App private key (PKCS#8 PEM) as an RSASSA
 * signing CryptoKey, failing with classified, non-retryable errors before
 * `atob`/`importKey` can throw unclassified DOMExceptions (the 2026-08-25
 * incident produced the legacy numeric `INVALID_CHARACTER_ERR` code 5 for a
 * PKCS#1 key). Messages carry the remedy, never key bytes (SECURITY.md).
 * @param {string} privateKey - PEM-encoded PKCS#8 private key
 * @returns {Promise<CryptoKey>} signing key
 */
async function importAppPrivateKey(privateKey) {
  if (NON_PKCS8_HEADER.test(privateKey)) {
    throw appAuthError(
      'app_key_wrong_format',
      'Private key is not PKCS#8 (GitHub downloads PKCS#1); convert with: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem, then re-store the secret',
      { retryable: false },
    );
  }

  // Normalize private key (remove headers, whitespace)
  const normalizedKey = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  if (!normalizedKey || /[^A-Za-z0-9+/=]/.test(normalizedKey)) {
    throw appAuthError(
      'app_key_invalid',
      'Private key body is not clean base64 — the stored secret is likely truncated or corrupted; re-store the whole PEM file',
      { retryable: false },
    );
  }

  try {
    const binaryKey = Uint8Array.from(atob(normalizedKey), (c) => c.charCodeAt(0));
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw appAuthError(
      'app_key_invalid',
      'Private key decodes but is not a PKCS#8 RSA key — wrong file or double-encoded value; re-store the whole PEM file',
      { retryable: false },
    );
  }
}

/**
 * Generates a JWT token signed with the app's private key.
 * Malformed keys reject with `app_key_wrong_format` / `app_key_invalid`.
 * @param {string} appId - GitHub App ID
 * @param {string} privateKey - PEM-encoded PKCS#8 private key
 * @returns {Promise<string>} JWT token
 */
export async function generateAppJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + 540, // 9 minutes (GitHub recommends max 10 min)
    iss: appId,
  };

  const header = { alg: 'RS256', typ: 'JWT' };

  const encoder = new TextEncoder();
  const encodedHeader = encodeBase64UrlBytes(encoder.encode(JSON.stringify(header)));
  const encodedPayload = encodeBase64UrlBytes(encoder.encode(JSON.stringify(payload)));

  // Validation + import live in importAppPrivateKey so malformed keys fail
  // classified (app_key_wrong_format / app_key_invalid), never as raw
  // DOMExceptions from atob/importKey.
  const cryptoKey = await importAppPrivateKey(privateKey);

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(`${encodedHeader}.${encodedPayload}`),
  );

  const encodedSignature = encodeBase64UrlBytes(new Uint8Array(signature));

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Maps an HTTP status from the installation-token endpoint to a classified
 * appAuthError. Only status + code are kept — raw response bodies must not
 * leak into logs or GitHub comments (SECURITY.md).
 */
function tokenEndpointError(status) {
  if (status === 401) {
    return appAuthError('app_jwt_rejected', 'GitHub rejected the app JWT (bad key or app id)', {
      retryable: false,
      status,
    });
  }
  if (status === 403) {
    return appAuthError('app_suspended', 'GitHub App is suspended or blocked', {
      retryable: false,
      status,
    });
  }
  if (status === 404) {
    return appAuthError('installation_not_found', 'Installation was removed or inaccessible', {
      retryable: false,
      status,
    });
  }
  // 5xx / 429 / anything else unexpected: worth another attempt later.
  return appAuthError('app_token_fetch_failed', `GitHub token endpoint returned ${status}`, {
    retryable: true,
    status,
  });
}

/**
 * Fetches an installation access token from GitHub.
 * @param {string} jwt - App JWT token
 * @param {string|number} installationId - Installation ID
 * @returns {Promise<string>} Installation access token
 */
export async function fetchInstallationToken(jwt, installationId) {
  let response;
  try {
    response = await fetch(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zai-code-bot-workers',
      },
    });
  } catch (error) {
    // Network-level failure (offline, DNS, timeout): transient.
    throw appAuthError('app_token_fetch_failed', `Token endpoint unreachable: ${error.message}`);
  }

  if (!response.ok) {
    // Drain the body so the connection can be reused, then classify.
    await response.text().catch(() => {});
    throw tokenEndpointError(response.status);
  }

  const data = await response.json();
  if (typeof data?.token !== 'string' || data.token === '') {
    throw appAuthError('app_token_fetch_failed', 'Token endpoint returned no token');
  }
  return data.token;
}

/**
 * Caches installation tokens to avoid generating JWT for every request.
 * Uses KV namespace for caching (optional optimization). Cache errors are
 * swallowed: a cache miss only costs an extra mint, never a failure.
 */
export class AppTokenCache {
  constructor(kvNamespace, ttl = 300) {
    this.kv = kvNamespace;
    this.ttl = ttl; // 5 minutes
  }

  async get(installationId) {
    if (!this.kv) return null;
    try {
      const { value } = await this.kv.get(`installation_token:${installationId}`, {
        type: 'json',
      });
      return value;
    } catch {
      return null;
    }
  }

  async set(installationId, token) {
    if (!this.kv) return;
    try {
      await this.kv.put(`installation_token:${installationId}`, JSON.stringify({ value: token }), {
        expirationTtl: this.ttl,
      });
    } catch {
      // Ignore cache errors
    }
  }
}

/**
 * Creates a token provider that handles JWT generation and caching.
 * Resolves both Secrets Store bindings through `resolveSecretValue` (the
 * documented happy path is a plain string, but the same store also surfaces
 * `{get()}` and Promise shapes depending on the wrangler/workerd version).
 *
 * @param {Object} env - Environment bindings (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, BOT_CACHE)
 * @returns {Promise<{available: boolean, getInstallationToken: function}>}
 */
export async function createTokenProvider(env) {
  const appId = await resolveSecretValue(env.GITHUB_APP_ID);
  const privateKey = await resolveSecretValue(env.GITHUB_APP_PRIVATE_KEY);
  const cache = env.BOT_CACHE ? new AppTokenCache(env.BOT_CACHE) : null;

  return {
    available: Boolean(appId && privateKey),
    async getInstallationToken(installationId) {
      if (!appId || !privateKey) {
        throw appAuthError(
          'app_auth_unconfigured',
          'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY not configured',
          { retryable: false },
        );
      }
      if (!installationId) {
        throw appAuthError('missing_installation_id', 'webhook/job carries no installation id', {
          retryable: false,
        });
      }

      const cached = cache ? await cache.get(installationId) : null;
      if (cached) return cached;

      const jwt = await generateAppJwt(appId, privateKey);
      const token = await fetchInstallationToken(jwt, installationId);

      if (cache) await cache.set(installationId, token);
      return token;
    },
  };
}
