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
});
