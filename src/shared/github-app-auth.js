/**
 * GitHub App Authentication for Cloudflare Workers.
 * Generates JWT and fetches Installation Access Tokens.
 */

const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Encodes a string to Base64URL format (for JWT).
 * @param {string} str - String to encode
 * @returns {string} Base64URL encoded string
 */
function encodeBase64Url(str) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(str)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Generates a JWT token signed with the app's private key.
 * @param {string} appId - GitHub App ID
 * @param {string} privateKey - PEM-encoded private key
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

  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));

  // Normalize private key (remove headers, whitespace)
  const normalizedKey = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binaryKey = Uint8Array.from(atob(normalizedKey), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );

  const encodedSignature = encodeBase64Url(
    String.fromCharCode(...new Uint8Array(signature))
  );

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Fetches an installation access token.
 * @param {string} jwt - App JWT token
 * @param {string|number} installationId - Installation ID
 * @returns {Promise<string>} Installation access token
 */
export async function getInstallationToken(jwt, installationId) {
  const response = await fetch(
    `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'zai-code-bot-workers',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    const err = new Error(`GitHub API error: ${response.status}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  const data = await response.json();
  return data.token;
}

/**
 * Caches installation tokens to avoid generating JWT for every request.
 * Uses KV namespace for caching (optional optimization).
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
      await this.kv.put(
        `installation_token:${installationId}`,
        JSON.stringify({ value: token }),
        { expirationTtl: this.ttl }
      );
    } catch {
      // Ignore cache errors
    }
  }
}

/**
 * Creates a token provider that handles JWT generation and caching.
 * @param {Object} env - Environment bindings (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, BOT_CACHE)
 * @returns {Object} Token provider with getInstallationToken method
 */
export function createTokenProvider(env) {
  const appId = env.GITHUB_APP_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  const cache = env.BOT_CACHE ? new AppTokenCache(env.BOT_CACHE) : null;

  return {
    async getInstallationToken(installationId) {
      // Try cache first
      if (cache) {
        const cached = await cache.get(installationId);
        if (cached) return cached;
      }

      // Generate new token
      const jwt = await generateAppJwt(appId, privateKey);
      const token = await getInstallationToken(jwt, installationId);

      // Cache it
      if (cache) {
        await cache.set(installationId, token);
      }

      return token;
    },
  };
}
