/**
 * Z.ai chat-completions client for Cloudflare Workers.
 *
 * Ported from the parent GitHub Action's Node client (src/lib/api.js, which
 * uses Node's `https` module) to the Workers runtime (`fetch`). The
 * retry/backoff/categorize/error-sanitization logic is runtime-agnostic and is
 * preserved here; only the transport was rewritten.
 *
 * Differences from the parent client:
 *  - transport: `fetch` + an `AbortController` timeout (no `https.request`);
 *  - `categorizeError` reads `error.status` (set from `response.status`)
 *    instead of regex-scraping the message;
 *  - `messages` (system + user) are passed BY THE CALLER — the parent baked a
 *    code-review system message into the request; here each handler owns its
 *    own prompt;
 *  - `fetch` and `sleep` are injectable so the unit tests stay deterministic
 *    (no real network, no real backoff delay).
 *
 * Returned shape of `call()` matches the parent: `{ success, data, usedFallback,
 * error }`, where `error` (when present) is `{ category, message, retryable,
 * attempts, totalDuration }` and `message` is already sanitized for logs/user
 * surfaces (no Bearer tokens / API keys leak).
 */

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2000;
// Progressive timeout multipliers — each retry gets a shorter timeout.
// 1st attempt: 100%, 2nd: 67%, 3rd: 50%, 4th: 33% (floor 10s).
const PROGRESSIVE_TIMEOUT_MULTIPLIERS = [1.0, 0.67, 0.5, 0.33];
const MIN_TIMEOUT_MS = 10000;

/**
 * @typedef {'auth'|'validation'|'provider'|'rate-limit'|'timeout'|'internal'} ErrorCategory
 */

/**
 * Factory. `fetch` and `sleep` are overridable (mainly for tests).
 * @param {Object} [config]
 * @param {number} [config.timeout=30000] - base request timeout (ms)
 * @param {number} [config.maxRetries=3]  - retry attempts beyond the first
 * @param {number} [config.baseDelay=2000] - base exponential-backoff delay (ms)
 * @param {Function} [config.fetch]       - injectable fetch (tests)
 * @param {Function} [config.sleep]       - injectable backoff sleeper (tests)
 */
export function createZaiClient(config = {}) {
  const baseTimeout = Number(config.timeout) || DEFAULT_TIMEOUT_MS;
  const maxRetries = Number(config.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelay = Number(config.baseDelay) || DEFAULT_BASE_DELAY_MS;
  const fetchImpl = config.fetch || fetch;
  const sleeper = config.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** Single transport call with a timeout. Throws on !ok / empty / abort. */
  async function complete({ apiKey, model, messages, timeoutMs }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(ZAI_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`Z.ai API error ${res.status}`);
        err.status = res.status; // categorizeError reads this directly
        try {
          err.body = await res.text();
        } catch {
          err.body = null;
        }
        throw err;
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('Z.ai API returned an empty response');
      return content;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    config: { timeout: baseTimeout, maxRetries, baseDelay },

    /**
     * Calls the Z.ai chat-completions endpoint with timeout, retry, and an
     * optional compact fallback prompt (swapped in after a timeout).
     * @param {Object} params
     * @param {string} params.apiKey
     * @param {string} params.model
     * @param {Array<{role:string,content:string}>} params.messages
     * @param {Array<{role:string,content:string}>} [params.fallbackMessages]
     * @param {Function} [params.onFallback]
     * @returns {Promise<{success:boolean, data?:string, usedFallback:boolean, error?:Object}>}
     */
    async call({ apiKey, model, messages, fallbackMessages, onFallback }) {
      let usedFallback = false;
      let attemptMessages = messages;
      const startTime = Date.now();
      let lastError;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const mult =
          PROGRESSIVE_TIMEOUT_MULTIPLIERS[
            Math.min(attempt, PROGRESSIVE_TIMEOUT_MULTIPLIERS.length - 1)
          ];
        const timeoutMs = Math.max(MIN_TIMEOUT_MS, Math.floor(baseTimeout * mult));
        try {
          const content = await complete({ apiKey, model, messages: attemptMessages, timeoutMs });
          return { success: true, data: content, usedFallback };
        } catch (error) {
          lastError = error;
          const categorized = categorizeError(error);

          // On a timeout after the 2nd attempt, switch to a compact fallback
          // prompt (if provided) to give the model a shorter input to chew on.
          if (
            categorized.category === 'timeout' &&
            attempt >= 1 &&
            fallbackMessages &&
            !usedFallback
          ) {
            usedFallback = true;
            attemptMessages = fallbackMessages;
            if (onFallback) onFallback({ attempt, originalError: error });
            // Fall through to the backoff below (still retry the fallback).
          }

          if (!categorized.retryable || attempt >= maxRetries) {
            return {
              success: false,
              data: null,
              usedFallback,
              error: {
                category: categorized.category,
                message: sanitizeErrorMessage(error),
                retryable: categorized.retryable,
                attempts: attempt + 1,
                totalDuration: Date.now() - startTime,
              },
            };
          }

          const delay = baseDelay * 2 ** attempt + Math.floor(Math.random() * 1000);
          await sleeper(delay);
        }
      }

      // Defensive — the loop always returns inside, but keep a safe tail.
      return {
        success: false,
        data: null,
        usedFallback,
        error: {
          category: 'internal',
          message: sanitizeErrorMessage(lastError),
          retryable: false,
          attempts: maxRetries + 1,
          totalDuration: Date.now() - startTime,
        },
      };
    },
  };
}

/**
 * Classifies an error to decide retryability. Reads `error.status` (set from
 * `response.status` by `complete()`) rather than scraping the message.
 * @param {Error & {status?: number, name?: string}} error
 * @returns {{category: ErrorCategory, retryable: boolean}}
 */
export function categorizeError(error) {
  const status = Number(error?.status);
  const message = String(error?.message || '');

  // Timeout — either our AbortController firing (AbortError/TimeoutError) or a
  // transport that surfaces a timed-out message.
  if (
    /timeout|timed out/i.test(message) ||
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError'
  ) {
    return { category: 'timeout', retryable: true };
  }

  if (status === 429) return { category: 'rate-limit', retryable: true };
  if (status === 401 || status === 403) return { category: 'auth', retryable: false };
  if (status === 400) return { category: 'validation', retryable: false };
  if (status >= 500 && status < 600) return { category: 'provider', retryable: true };

  // Empty-content success or a transport failure — both worth a retry.
  if (/empty response/i.test(message)) return { category: 'provider', retryable: true };
  if (/econnrefused|enetunreach|fetch failed|network/i.test(message)) {
    return { category: 'provider', retryable: true };
  }

  return { category: 'internal', retryable: false };
}

/**
 * Strips Bearer tokens / api keys / credentialed URLs from an error message so
 * it is safe to log or surface. Truncates overlong messages. Mirrors the parent
 * bot's sanitizer; kept self-contained (no secret ever reaches a PR comment).
 * @param {Error} error
 * @returns {string}
 */
export function sanitizeErrorMessage(error) {
  let message = String(error?.message || 'An unknown error occurred');

  message = message.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
  message = message.replace(/(api[_-]?key[=:]?\s*)[^\s,}]+/gi, '$1[REDACTED]');
  message = message.replace(/(Authorization:\s*)[^\s]+/gi, '$1[REDACTED]');
  message = message.replace(/https?:\/\/[^\s]*:[^\s@]+@[^\s]*/gi, '[URL_REDACTED]');

  if (message.length > 300) message = `${message.slice(0, 300)}...`;
  return message;
}

export { ZAI_API_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_BASE_DELAY_MS };
