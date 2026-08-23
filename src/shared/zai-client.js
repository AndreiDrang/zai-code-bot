/**
 * Z.ai chat-completions client for Cloudflare Workers.
 *
 * Uses the Workers `fetch` transport with retry, backoff, error categorization,
 * and credential sanitization.
 *
 * Differences from the parent client:
 *  - transport: `fetch` + an `AbortController` timeout (no `https.request`);
 *  - `categorizeError` reads `error.status` (set from `response.status`)
 *    instead of regex-scraping the message;
 *  - `messages` (system + user) are passed by the caller, so each handler owns
 *    its own prompt;
 *  - `fetch` and `sleep` are injectable so the unit tests stay deterministic
 *    (no real network, no real backoff delay).
 *
 * The returned error message is sanitized for logs and user surfaces.
 */

const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2000;
// Non-agent calls keep their historical progressive retry timeouts.
// Agent calls use a fixed timeout per attempt so a reasoning response is not
// guaranteed to be aborted sooner after its first timeout.
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
 * @param {Function} [config.now]         - injectable clock (tests)
 */
export function createZaiClient(config = {}) {
  const baseTimeout = Number(config.timeout) || DEFAULT_TIMEOUT_MS;
  const maxRetries = Number(config.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelay = Number(config.baseDelay) || DEFAULT_BASE_DELAY_MS;
  const fetchImpl = config.fetch || fetch;
  const sleeper = config.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = config.now || (() => Date.now());

  /** Single transport call with a timeout. Throws on !ok / malformed / abort. */
  async function complete({ apiKey, model, messages, tools, timeoutMs }) {
    const controller = new AbortController();
    const request = toChatRequest({ model, messages, tools });
    const body = JSON.stringify(request);
    const requestBytes = new TextEncoder().encode(body).byteLength;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const res = await fetchImpl(ZAI_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = new Error(`Z.ai API error ${res.status}`);
        err.status = res.status; // categorizeError reads this directly
        err.retryAfterMs = readRetryAfterMs(res.headers, now);
        err.providerRequestId = readProviderRequestId(res.headers);
        try {
          err.body = await res.text();
        } catch {
          err.body = null;
        }
        throw err;
      }
      const data = await res.json();
      const message = data?.choices?.[0]?.message;
      if (!message || typeof message !== 'object') {
        throw new Error('Z.ai API returned no assistant message');
      }
      const hasContent = typeof message.content === 'string' && message.content.length > 0;
      const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      if (!hasContent && !hasToolCalls) throw new Error('Z.ai API returned an empty response');
      return {
        message: { ...message, role: 'assistant' },
        usage: normalizeUsage(data?.usage),
        transport: {
          httpStatus: res.status,
          providerRequestId: readProviderRequestId(res.headers),
          requestBytes,
        },
      };
    } catch (error) {
      if (timedOut && error?.name === 'AbortError') {
        const timeoutError = new Error('Z.ai client request timed out');
        timeoutError.name = 'TimeoutError';
        timeoutError.requestBytes = requestBytes;
        throw timeoutError;
      }
      if (error && typeof error === 'object' && error.requestBytes == null) {
        error.requestBytes = requestBytes;
      }
      throw error;
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
          const data = await complete({ apiKey, model, messages: attemptMessages, timeoutMs });
          if (typeof data.message.content !== 'string' || !data.message.content) {
            throw new Error('Z.ai API returned an empty response');
          }
          return { success: true, data: data.message.content, usedFallback };
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

    /**
     * Executes one chat-completions request for AgentRunner. It deliberately
     * does not interpret tool calls or retain conversation state. Agent
     * attempts use a fixed timeout so a reasoning request is not progressively
     * shortened on retry.
     * @returns {Promise<{success:boolean,data?:{message:Object,usage:Object|null},error?:Object}>}
     */
    async chat({
      apiKey,
      model,
      messages,
      tools,
      timeoutMs = baseTimeout,
      deadlineAt,
      maxAttempts = maxRetries + 1,
      retryTimeouts = true,
      onAttempt,
    }) {
      const startTime = now();
      let lastError;
      const attemptLimit = Math.max(1, Math.floor(Number(maxAttempts) || 1));
      for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
        const remainingMs = Number.isFinite(deadlineAt)
          ? Math.max(0, deadlineAt - now())
          : Number.POSITIVE_INFINITY;
        if (remainingMs <= 0) {
          return timedOutChatResult(lastError, attempt, startTime, now);
        }
        const requestTimeout = Math.max(1, Math.floor(Math.min(timeoutMs, remainingMs)));
        if (requestTimeout < MIN_TIMEOUT_MS) {
          return timedOutChatResult(lastError, attempt, startTime, now);
        }
        const attemptStartedAt = now();
        try {
          const data = await complete({
            apiKey,
            model,
            messages,
            tools,
            timeoutMs: requestTimeout,
          });
          onAttempt?.({
            attempt: attempt + 1,
            category: null,
            durationMs: now() - attemptStartedAt,
            remainingMs,
            requestTimeoutMs: requestTimeout,
            httpStatus: data.transport?.httpStatus ?? null,
            providerRequestId: data.transport?.providerRequestId ?? null,
            requestBytes: data.transport?.requestBytes ?? null,
            success: true,
          });
          return { success: true, data };
        } catch (error) {
          lastError = error;
          const categorized = categorizeError(error);
          onAttempt?.({
            attempt: attempt + 1,
            category: categorized.category,
            durationMs: now() - attemptStartedAt,
            remainingMs,
            requestTimeoutMs: requestTimeout,
            httpStatus: Number.isFinite(error?.status) ? error.status : null,
            retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null,
            providerRequestId: error?.providerRequestId || null,
            requestBytes: Number.isFinite(error?.requestBytes) ? error.requestBytes : null,
            success: false,
          });
          if (
            !categorized.retryable ||
            attempt + 1 >= attemptLimit ||
            (categorized.category === 'timeout' && !retryTimeouts)
          ) {
            return {
              success: false,
              error: {
                category: categorized.category,
                message: sanitizeErrorMessage(error),
                retryable: categorized.retryable,
                attempts: attempt + 1,
                totalDuration: now() - startTime,
                httpStatus: Number.isFinite(error?.status) ? error.status : null,
                providerRequestId: error?.providerRequestId || null,
              },
            };
          }
          const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0;
          const delay = Math.max(
            retryAfterMs,
            baseDelay * 2 ** attempt + Math.floor(Math.random() * 1000),
          );
          const remainingAfterAttempt = Number.isFinite(deadlineAt)
            ? Math.max(0, deadlineAt - now())
            : Number.POSITIVE_INFINITY;
          if (remainingAfterAttempt < delay + MIN_TIMEOUT_MS) {
            return timedOutChatResult(lastError, attempt + 1, startTime, now);
          }
          await sleeper(delay);
        }
      }
      return {
        success: false,
        error: {
          category: 'internal',
          message: sanitizeErrorMessage(lastError),
          retryable: false,
          attempts: attemptLimit,
          totalDuration: now() - startTime,
        },
      };
    },
  };
}

function timedOutChatResult(lastError, attempts, startTime, now) {
  return {
    success: false,
    error: {
      category: 'timeout',
      message: sanitizeErrorMessage(lastError || new Error('Agent deadline exceeded')),
      retryable: true,
      attempts,
      totalDuration: now() - startTime,
      httpStatus: Number.isFinite(lastError?.status) ? lastError.status : null,
      providerRequestId: lastError?.providerRequestId || null,
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

function toChatRequest({ model, messages, tools }) {
  const request = { model, messages };
  if (Array.isArray(tools) && tools.length) request.tools = tools;
  return request;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    promptTokens: Number(usage.prompt_tokens) || null,
    completionTokens: Number(usage.completion_tokens) || null,
    totalTokens: Number(usage.total_tokens) || null,
  };
}

function readProviderRequestId(headers) {
  if (!headers?.get) return null;
  for (const name of ['x-request-id', 'request-id', 'x-trace-id']) {
    const value = headers.get(name);
    if (typeof value === 'string' && value) return value.slice(0, 200);
  }
  return null;
}

function readRetryAfterMs(headers, now) {
  const value = headers?.get?.('retry-after');
  if (typeof value !== 'string' || !value.trim()) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - now());
}

export { ZAI_API_URL, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RETRIES, DEFAULT_BASE_DELAY_MS };
