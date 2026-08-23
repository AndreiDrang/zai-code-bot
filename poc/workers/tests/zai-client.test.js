import { describe, expect, it, vi } from 'vitest';
import {
  createZaiClient,
  categorizeError,
  sanitizeErrorMessage,
  ZAI_API_URL,
} from '../shared/zai-client.js';

// No real backoff in tests — keep retries instant.
const noSleep = () => Promise.resolve();

function okResponse(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  };
}
function errResponse(status, body = '') {
  return { ok: false, status, text: async () => body, json: async () => ({}) };
}
function emptyResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '' } }] }),
    text: async () => '',
  };
}
function toolCallResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'get_diff', arguments: '{"path":"src/cache.ts"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }),
    text: async () => '',
  };
}

describe('zai-client — categorizeError', () => {
  it('classifies a timeout from an AbortError', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(categorizeError(e)).toMatchObject({ category: 'timeout', retryable: true });
  });

  it('classifies HTTP status codes', () => {
    const mk = (s) => Object.assign(new Error(`err ${s}`), { status: s });
    expect(categorizeError(mk(429))).toMatchObject({ category: 'rate-limit', retryable: true });
    expect(categorizeError(mk(401))).toMatchObject({ category: 'auth', retryable: false });
    expect(categorizeError(mk(403))).toMatchObject({ category: 'auth', retryable: false });
    expect(categorizeError(mk(400))).toMatchObject({ category: 'validation', retryable: false });
    expect(categorizeError(mk(503))).toMatchObject({ category: 'provider', retryable: true });
  });

  it('classifies an empty-content success as a retryable provider error', () => {
    expect(categorizeError(new Error('Z.ai API returned an empty response'))).toMatchObject({
      category: 'provider',
      retryable: true,
    });
  });

  it('classifies timeouts from TimeoutError names and timeout messages', () => {
    const named = new Error('aborted');
    named.name = 'TimeoutError';
    expect(categorizeError(named)).toMatchObject({ category: 'timeout', retryable: true });
    expect(categorizeError(new Error('Request timed out'))).toMatchObject({
      category: 'timeout',
      retryable: true,
    });
    expect(categorizeError(new Error('the operation timed out mid-flight'))).toMatchObject({
      category: 'timeout',
      retryable: true,
    });
  });

  it('classifies transport failures as retryable provider errors', () => {
    for (const message of ['fetch failed', 'ECONNREFUSED 1.2.3.4:443', 'network unreachable']) {
      expect(categorizeError(new Error(message))).toMatchObject({
        category: 'provider',
        retryable: true,
      });
    }
  });

  it('falls back to a non-retryable internal error for unrecognized errors', () => {
    expect(categorizeError(new Error('something else entirely'))).toMatchObject({
      category: 'internal',
      retryable: false,
    });
    // A non-numeric status does not coerce and must not match any status bucket.
    expect(
      categorizeError(Object.assign(new Error('odd'), { status: 'unavailable' })),
    ).toMatchObject({
      category: 'internal',
      retryable: false,
    });
  });
});

describe('zai-client — sanitizeErrorMessage', () => {
  it('redacts Bearer tokens and api keys', () => {
    const e = new Error('Authorization: Bearer sk-secret123 failed; api_key=abc');
    const out = sanitizeErrorMessage(e);
    expect(out).not.toContain('sk-secret123');
    expect(out).not.toContain('abc');
    expect(out).toContain('[REDACTED]');
  });

  it('truncates overlong messages', () => {
    const out = sanitizeErrorMessage(new Error('x'.repeat(500)));
    expect(out.length).toBeLessThan(310);
    expect(out).toContain('...');
  });
});

describe('zai-client — createZaiClient.call', () => {
  it('returns the message content on success and hits the Z.ai endpoint', async () => {
    const fetchImpl = vi.fn(async () => okResponse('looks good'));
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep });
    const res = await client.call({
      apiKey: 'k',
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(ZAI_API_URL);
    const sentInit = fetchImpl.mock.calls[0][1];
    expect(sentInit.body).toContain('"model":"glm-5.2"');
    expect(sentInit.body).toContain('"content":"hi"');
    expect(sentInit.body).not.toContain('authorization'); // auth lives on init.headers, not body
    expect(sentInit.headers.authorization).toBe('Bearer k');
    expect(res).toMatchObject({ success: true, data: 'looks good', usedFallback: false });
  });

  it('does NOT retry a non-retryable auth error (single attempt)', async () => {
    const fetchImpl = vi.fn(async () => errResponse(401));
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep });
    const res = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(false);
    expect(res.error).toMatchObject({ category: 'auth', retryable: false, attempts: 1 });
  });

  it('retries a provider 500 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errResponse(500))
      .mockResolvedValueOnce(okResponse('recovered'));
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 2 });
    const res = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ success: true, data: 'recovered' });
  });

  it('exhausts retries on a persistent 500 and reports the attempt count', async () => {
    const fetchImpl = vi.fn(async () => errResponse(500));
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 1 });
    const res = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(res.success).toBe(false);
    expect(res.error).toMatchObject({ category: 'provider', retryable: true, attempts: 2 });
  });

  it('classifies an AbortError as a retryable timeout', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn(async () => {
      throw abort;
    });
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 1 });
    const res = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    expect(res.success).toBe(false);
    expect(res.error.category).toBe('timeout');
  });

  it('treats an empty-content 200 as a retryable provider error', async () => {
    const fetchImpl = vi.fn(async () => emptyResponse());
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 0 });
    const res = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    expect(res.success).toBe(false);
    expect(res.error.category).toBe('provider');
  });

  it('switches to fallbackMessages after a timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw abort;
      }) // attempt 0: timeout
      .mockImplementationOnce(async () => {
        throw abort;
      }) // attempt 1: timeout -> switch to fallback
      .mockResolvedValueOnce(okResponse('short review')); // attempt 2: success with fallback
    const onFallback = vi.fn();
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 3 });
    const res = await client.call({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'long' }],
      fallbackMessages: [{ role: 'user', content: 'short' }],
      onFallback,
    });
    expect(res).toMatchObject({ success: true, data: 'short review', usedFallback: true });
    expect(onFallback).toHaveBeenCalled();
    const lastBody = fetchImpl.mock.calls[2][1].body;
    expect(lastBody).toContain('"content":"short"');
    expect(lastBody).not.toContain('"content":"long"');
  });

  it('sends OpenAI-compatible tools and preserves a tool-call assistant message', async () => {
    const fetchImpl = vi.fn(async () => toolCallResponse());
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 0 });
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_diff',
          description: 'Get one patch.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];

    const result = await client.chat({
      apiKey: 'key',
      model: 'model',
      messages: [{ role: 'user', content: 'review' }],
      tools,
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        message: { role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call-1' })] },
        usage: { totalTokens: 14 },
      },
    });
    expect(fetchImpl.mock.calls[0][1].body).toContain('"tools"');
    expect(fetchImpl.mock.calls[0][1].body).toContain('"get_diff"');
  });

  it('allows an agent request timeout longer than the client default', async () => {
    const fetchImpl = vi.fn(async () => okResponse('review complete'));
    const onAttempt = vi.fn();
    const client = createZaiClient({
      fetch: fetchImpl,
      sleep: noSleep,
      now: () => 0,
    });

    await expect(
      client.chat({
        apiKey: 'key',
        model: 'model',
        messages: [{ role: 'user', content: 'review' }],
        timeoutMs: 90000,
        deadlineAt: 120000,
        maxAttempts: 2,
        onAttempt,
      }),
    ).resolves.toMatchObject({ success: true });

    expect(onAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        requestTimeoutMs: 90000,
        httpStatus: 200,
        requestBytes: expect.any(Number),
      }),
    );
  });

  it('does not retry a timed-out gathering request when evidence is already available', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn(async () => {
      throw abort;
    });
    const client = createZaiClient({
      fetch: fetchImpl,
      sleep: noSleep,
      now: () => 0,
    });

    const result = await client.chat({
      apiKey: 'key',
      model: 'model',
      messages: [{ role: 'user', content: 'review' }],
      timeoutMs: 90000,
      deadlineAt: 120000,
      maxAttempts: 2,
      retryTimeouts: false,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      error: { category: 'timeout', retryable: true, attempts: 1 },
    });
  });

  it('uses Retry-After and the configured total attempt limit for agent retries', async () => {
    const rateLimited = errResponse(429);
    rateLimited.headers = {
      get(name) {
        return name.toLowerCase() === 'retry-after' ? '5' : null;
      },
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(okResponse('review complete'));
    const sleep = vi.fn(() => Promise.resolve());
    const onAttempt = vi.fn();
    const client = createZaiClient({
      fetch: fetchImpl,
      sleep,
      baseDelay: 10,
      now: () => 0,
    });

    await expect(
      client.chat({
        apiKey: 'key',
        model: 'model',
        messages: [{ role: 'user', content: 'review' }],
        timeoutMs: 90000,
        deadlineAt: 120000,
        maxAttempts: 2,
        onAttempt,
      }),
    ).resolves.toMatchObject({ success: true });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(onAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        category: 'rate-limit',
        httpStatus: 429,
        retryAfterMs: 5000,
      }),
    );
  });

  it('does not start an LLM request that cannot run for the minimum viable timeout', async () => {
    const fetchImpl = vi.fn(async () => errResponse(500));
    const client = createZaiClient({
      fetch: fetchImpl,
      sleep: noSleep,
      maxRetries: 3,
      baseDelay: 10,
      now: () => 0,
    });

    const result = await client.chat({
      apiKey: 'key',
      model: 'model',
      messages: [{ role: 'user', content: 'review' }],
      deadlineAt: 5,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      error: { category: 'timeout', retryable: true, attempts: 0 },
    });
  });
});

describe('zai-client — transport edges', () => {
  it('attaches requestBytes and reports transport nulls on network failures', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('fetch failed')));
    const onAttempt = vi.fn();
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 0 });

    const result = await client.chat({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxAttempts: 1,
      onAttempt,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      category: 'provider',
      httpStatus: null,
      providerRequestId: null,
    });
    const failure = onAttempt.mock.calls.map(([call]) => call).find((call) => !call.success);
    expect(failure).toMatchObject({
      category: 'provider',
      httpStatus: null,
      retryAfterMs: null,
      providerRequestId: null,
    });
    expect(Number.isFinite(failure.requestBytes)).toBe(true);
    expect(failure.requestBytes).toBeGreaterThan(0);
  });

  it('survives error bodies that fail to load', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error('unreadable')),
      }),
    );
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 0 });
    const result = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    // Retryable per categorization even though the attempt budget is exhausted.
    expect(result.error).toMatchObject({ category: 'provider', retryable: true, attempts: 1 });
  });

  it('surfaces a protocol error when the response has no assistant message', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
    );
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 0 });
    const result = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    expect(result.error).toMatchObject({ category: 'internal', retryable: false });
    expect(result.error.message).toContain('no assistant message');
  });

  it('treats a tool-call-only response as empty for call()', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(toolCallResponse()));
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, maxRetries: 0 });
    const result = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    expect(result.error).toMatchObject({ category: 'provider', attempts: 1 });
    expect(result.error.message).toContain('empty response');
  });

  it('returns the defensive tail result when maxRetries is negative', async () => {
    const client = createZaiClient({ fetch: vi.fn(), sleep: noSleep, maxRetries: -1 });
    const result = await client.call({ apiKey: 'k', model: 'm', messages: [] });
    expect(result).toMatchObject({
      success: false,
      usedFallback: false,
      error: { category: 'internal', retryable: false, attempts: 0 },
    });
    expect(client.config).toMatchObject({ timeout: 30000, maxRetries: -1, baseDelay: 2000 });
  });

  it('uses the global fetch and the default sleeper when not injected', async () => {
    const globalFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => '',
      })
      .mockResolvedValueOnce(okResponse('done'));
    vi.stubGlobal('fetch', globalFetch);
    try {
      const client = createZaiClient({ baseDelay: 1, maxRetries: 1 });
      const result = await client.call({ apiKey: 'k', model: 'm', messages: [] });
      expect(result).toMatchObject({ success: true, data: 'done' });
      expect(globalFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('zai-client — chat deadlines and retries', () => {
  it('aborts a hanging request at the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      );
      const onAttempt = vi.fn();
      const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, now: () => 0 });

      const pending = client.chat({
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 10000,
        maxAttempts: 1,
        onAttempt,
      });
      await vi.advanceTimersByTimeAsync(10000);
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.error).toMatchObject({ category: 'timeout', retryable: true, attempts: 1 });
      expect(result.error.message).toContain('timed out');
      const failure = onAttempt.mock.calls.map(([call]) => call).find((call) => !call.success);
      expect(failure.requestBytes).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps maxAttempts to at least one', async () => {
    const onAttempt = vi.fn();
    const client = createZaiClient({
      fetch: vi.fn(() => Promise.resolve(okResponse('ok'))),
      sleep: noSleep,
    });
    const result = await client.chat({
      apiKey: 'k',
      model: 'm',
      messages: [],
      maxAttempts: 0,
      onAttempt,
    });
    expect(result.success).toBe(true);
    expect(onAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, success: true }),
    );
  });

  it('returns a timeout result when the deadline is already past', async () => {
    const fixedNow = 1700000000000;
    const fetchImpl = vi.fn();
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, now: () => fixedNow });
    const result = await client.chat({
      apiKey: 'k',
      model: 'm',
      messages: [],
      deadlineAt: fixedNow - 5,
    });
    expect(result).toMatchObject({
      success: false,
      error: { category: 'timeout', retryable: true, attempts: 0 },
    });
    expect(result.error.message).toContain('Agent deadline exceeded');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('times out when the remaining budget cannot fit the next retry', async () => {
    const fixedNow = 1700000000000;
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '5' }),
        text: async () => '',
      }),
    );
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep, now: () => fixedNow });
    const result = await client.chat({
      apiKey: 'k',
      model: 'm',
      messages: [],
      deadlineAt: fixedNow + 12000,
      maxAttempts: 4,
    });
    expect(result).toMatchObject({
      success: false,
      error: { category: 'timeout', retryable: true, attempts: 1, httpStatus: 429 },
    });
  });

  it('retries a plain 500 without retry-after and succeeds', async () => {
    const onAttempt = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'x-request-id': 'req-9' }),
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      });
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep });
    const result = await client.chat({ apiKey: 'k', model: 'm', messages: [], onAttempt });
    expect(result.success).toBe(true);
    expect(result.data.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(result.data.transport).toMatchObject({ httpStatus: 200, providerRequestId: 'req-9' });
    const successCall = onAttempt.mock.calls.map(([call]) => call).find((call) => call.success);
    expect(successCall.providerRequestId).toBe('req-9');
  });
});

describe('zai-client — header and usage parsing', () => {
  it('reads provider request ids from several header names', async () => {
    const withHeader = (name, value) => ({
      ok: true,
      status: 200,
      headers: new Headers({ [name]: value }),
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    for (const [name, value] of [
      ['request-id', 'r-1'],
      ['x-trace-id', 't-1'],
      ['x-request-id', ''],
    ]) {
      const client = createZaiClient({
        fetch: vi.fn(() => Promise.resolve(withHeader(name, value))),
        sleep: noSleep,
      });
      const result = await client.chat({ apiKey: 'k', model: 'm', messages: [] });
      expect(result.data.transport.providerRequestId).toBe(value || null);
    }
  });

  it('normalizes garbage usage values to nulls', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 'x', completion_tokens: null, total_tokens: 7 },
        }),
      }),
    );
    const client = createZaiClient({ fetch: fetchImpl, sleep: noSleep });
    const result = await client.chat({ apiKey: 'k', model: 'm', messages: [] });
    expect(result.data.usage).toEqual({ promptTokens: null, completionTokens: null, totalTokens: 7 });
  });

  it('parses numeric and HTTP-date retry-after values', async () => {
    const fixedNow = 1700000000000;
    const withRetryAfter = (value) => ({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': value }),
      text: async () => '',
    });
    const cases = [
      ['2', 2000],
      [new Date(fixedNow + 60000).toISOString(), 60000],
      // Negative values fall through to the date parse, which clamps past
      // dates to zero — an immediate retry, never a negative delay.
      ['-1', 0],
      ['not-a-date', null],
    ];
    for (const [value, expected] of cases) {
      const onAttempt = vi.fn();
      const client = createZaiClient({
        fetch: vi.fn(() => Promise.resolve(withRetryAfter(value))),
        sleep: noSleep,
        now: () => fixedNow,
        maxRetries: 0,
      });
      await client.chat({ apiKey: 'k', model: 'm', messages: [], maxAttempts: 1, onAttempt });
      const failure = onAttempt.mock.calls.map(([call]) => call).find((call) => !call.success);
      expect(failure.retryAfterMs).toBe(expected);
    }
  });

  it('sanitizes missing messages and credentialed URLs', () => {
    expect(sanitizeErrorMessage(null)).toBe('An unknown error occurred');
    expect(sanitizeErrorMessage(new Error('failed https://user:pass@host/path'))).toBe(
      'failed [URL_REDACTED]',
    );
  });
});
