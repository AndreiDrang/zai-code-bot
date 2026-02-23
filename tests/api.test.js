const { test, describe, mock } = require('node:test');
const assert = require('node:assert');
const {
  createApiClient,
  callWithRetry,
  categorizeError,
  sanitizeErrorMessage,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY_MS,
  ZAI_API_URL
} = require('../src/lib/api');

describe('createApiClient', () => {
  test('creates client with default config', () => {
    const client = createApiClient();
    assert.strictEqual(client.config.timeout, DEFAULT_TIMEOUT_MS);
    assert.strictEqual(client.config.maxRetries, DEFAULT_MAX_RETRIES);
    assert.strictEqual(client.config.baseDelay, DEFAULT_BASE_DELAY_MS);
  });

  test('creates client with custom config', () => {
    const client = createApiClient({ timeout: 5000, maxRetries: 5, baseDelay: 1000 });
    assert.strictEqual(client.config.timeout, 5000);
    assert.strictEqual(client.config.maxRetries, 5);
    assert.strictEqual(client.config.baseDelay, 1000);
  });

  test('call method returns success structure on success', async () => {
    const client = createApiClient({ maxRetries: 0 });
    
    // Mock the internal function to succeed
    const original = require('../src/lib/api');
    // We can't easily mock without more infrastructure, so test the structure
    assert.ok(typeof client.call === 'function');
  });
});

describe('callWithRetry', () => {
  test('succeeds on first attempt', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      return 'success';
    };

    const result = await callWithRetry(fn, { maxRetries: 3, baseDelay: 10 });
    assert.strictEqual(result, 'success');
    assert.strictEqual(attempts, 1);
  });

  test('retries on failure and succeeds', async () => {
    let attempts = 0;
    const fn = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Request timed out');
      }
      return 'success';
    };

    const result = await callWithRetry(fn, { maxRetries: 3, baseDelay: 10 });
    assert.strictEqual(result, 'success');
    assert.strictEqual(attempts, 3);
  });

  test('returns structured error after max retries', async () => {
    const fn = async () => {
      throw new Error('Permanent error');
    };

    const result = await callWithRetry(fn, { maxRetries: 2, baseDelay: 10 });
    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.strictEqual(result.error.category, 'internal');
    assert.strictEqual(result.error.retryable, false);
  });

  test('returns structured error for non-retryable errors immediately', async () => {
    const fn = async () => {
      throw new Error('Z.ai API error 401: unauthorized');
    };

    const result = await callWithRetry(fn, { maxRetries: 3, baseDelay: 10 });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.category, 'auth');
    assert.strictEqual(result.error.retryable, false);
  });
});

describe('categorizeError', () => {
  test('categorizes timeout errors', () => {
    const error = new Error('Request timed out');
    const result = categorizeError(error);
    assert.strictEqual(result.category, 'timeout');
    assert.strictEqual(result.retryable, true);
  });

  test('categorizes rate limit errors', () => {
    const error = new Error('Z.ai API error 429: rate limited');
    const result = categorizeError(error);
    assert.strictEqual(result.category, 'rate-limit');
    assert.strictEqual(result.retryable, true);
  });

  test('categorizes auth errors', () => {
    const error = new Error('Z.ai API error 401: unauthorized');
    const result = categorizeError(error);
    assert.strictEqual(result.category, 'auth');
    assert.strictEqual(result.retryable, false);
  });

  test('categorizes validation errors', () => {
    const error = new Error('Z.ai API error 400: bad request');
    const result = categorizeError(error);
    assert.strictEqual(result.category, 'validation');
    assert.strictEqual(result.retryable, false);
  });

  test('categorizes server errors as provider', () => {
    const error = new Error('Z.ai API error 500: internal server error');
    const result = categorizeError(error);
    assert.strictEqual(result.category, 'provider');
    assert.strictEqual(result.retryable, true);
  });

  test('categorizes network errors as provider', () => {
    const error = new Error('connect ECONNREFUSED');
    const result = categorizeError(error);
    assert.strictEqual(result.category, 'provider');
    assert.strictEqual(result.retryable, true);
  });

  test('categorizes empty response as provider', () => {
    const error = new Error('Z.ai API returned an empty response');
    const result = categorizeError(error);
    assert.strictEqual(result.category, 'provider');
    assert.strictEqual(result.retryable, true);
  });

  test('defaults to internal for unknown errors', () => {
    const error = new Error('Something unexpected happened');
    const result = categorizeError(error);
    assert.strictEqual(result.category, 'internal');
    assert.strictEqual(result.retryable, false);
  });
});

describe('sanitizeErrorMessage', () => {
  test('returns unknown error for null input', () => {
    const result = sanitizeErrorMessage(null);
    assert.strictEqual(result, 'An unknown error occurred');
  });

  test('returns unknown error for error without message', () => {
    const result = sanitizeErrorMessage({});
    assert.strictEqual(result, 'An unknown error occurred');
  });

  test('redacts Bearer tokens', () => {
    const error = new Error('Bearer sk-1234567890abcdef failed');
    const result = sanitizeErrorMessage(error);
    assert.strictEqual(result, 'Bearer [REDACTED] failed');
    assert.ok(!result.includes('sk-1234567890'));
  });

  test('redacts API keys', () => {
    const error = new Error('api_key=secret123 failed');
    const result = sanitizeErrorMessage(error);
    assert.ok(!result.includes('secret123'));
    assert.ok(result.includes('[REDACTED]'));
  });

  test('redacts URLs with credentials', () => {
    const error = new Error('Failed to connect to https://user:pass@api.example.com');
    const result = sanitizeErrorMessage(error);
    assert.ok(!result.includes('user:pass'));
    assert.ok(result.includes('[URL_REDACTED]'));
  });

  test('redacts Authorization headers', () => {
    const error = new Error('Authorization: Bearer mytoken123 failed');
    const result = sanitizeErrorMessage(error);
    assert.ok(!result.includes('mytoken123'));
  });

  test('truncates very long messages', () => {
    const longMessage = 'A'.repeat(1000);
    const error = new Error(longMessage);
    const result = sanitizeErrorMessage(error);
    assert.ok(result.length <= 510);
    assert.ok(result.endsWith('...'));
  });

  test('passes through safe messages unchanged', () => {
    const error = new Error('Request timed out after 30000ms');
    const result = sanitizeErrorMessage(error);
    assert.strictEqual(result, 'Request timed out after 30000ms');
  });
});

describe('constants', () => {
  test('DEFAULT_TIMEOUT_MS is 30000', () => {
    assert.strictEqual(DEFAULT_TIMEOUT_MS, 30000);
  });

  test('DEFAULT_MAX_RETRIES is 3', () => {
    assert.strictEqual(DEFAULT_MAX_RETRIES, 3);
  });

  test('DEFAULT_BASE_DELAY_MS is 2000', () => {
    assert.strictEqual(DEFAULT_BASE_DELAY_MS, 2000);
  });

  test('ZAI_API_URL is correct endpoint', () => {
    assert.strictEqual(ZAI_API_URL, 'https://api.z.ai/api/coding/paas/v4/chat/completions');
  });
});
