/**
 * Secrets Store binding resolver — shared by both workers.
 *
 * WHY THIS EXISTS
 * A `[[secrets_store_secrets]]` binding is documented to surface as a plain
 * `env.<binding>` string, but at runtime (depending on the wrangler/workerd
 * version in use) the value can arrive as any of:
 *
 *   - a `string`                              (documented happy path)
 *   - an object exposing `.get(): Promise<string>`  (older binding shape)
 *   - a thenable `Promise<string>`            (another binding shape)
 *
 * Passing the raw binding straight into `TextEncoder.encode()` (webhook HMAC)
 * or an `Authorization: token <value>` header stringifies it to
 * `"[object Object]"` / `"[object Promise]"`, which silently breaks signature
 * verification and API auth — the worker compiles and runs, but every check
 * fails with no clue why.
 *
 * This helper normalizes all three shapes to a trimmed string (or `undefined`
 * when empty/invalid), mirroring the proven `resolveSecretValue` in
 * RedPandaDev/tbel `cf_workers/common/utils.ts`, which is confirmed working
 * against the same Secrets Store (629e5dd…).
 *
 * USAGE: resolve at the edge, pass a plain string down.
 *   const token = await resolveSecretValue(env.GITHUB_TOKEN);
 *   new GitHubClient(token);
 */

/**
 * Resolve a Secrets Store binding (string | {get()} | Promise) to a trimmed
 * string. Returns `undefined` for empty / whitespace-only / unrecognized
 * values so callers can treat "no secret" uniformly.
 *
 * @param {unknown} secret - the raw `env.<binding>` value
 * @returns {Promise<string | undefined>}
 */
export async function resolveSecretValue(secret) {
  // 1. Plain string (the documented happy path).
  if (typeof secret === 'string') {
    const trimmed = secret.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  if (!secret || typeof secret !== 'object') {
    return undefined;
  }

  // 2. Object form: { get(): Promise<string> } (older Secrets Store binding).
  if (typeof secret.get === 'function') {
    try {
      const resolved = await secret.get();
      if (typeof resolved !== 'string') return undefined;
      const trimmed = resolved.trim();
      return trimmed === '' ? undefined : trimmed;
    } catch (error) {
      // A TypeError here means the binding isn't actually a secret getter
      // (e.g. a Fetcher-like object misused as one); treat as missing rather
      // than crashing the request. Other errors (genuine secret read
      // failures) propagate so callers can handle them.
      if (error instanceof TypeError) return undefined;
      throw error;
    }
  }

  // 3. Thenable / Promise form.
  if (typeof secret.then === 'function') {
    try {
      const resolved = await secret;
      if (typeof resolved !== 'string') return undefined;
      const trimmed = resolved.trim();
      return trimmed === '' ? undefined : trimmed;
    } catch {
      return undefined;
    }
  }

  return undefined;
}
