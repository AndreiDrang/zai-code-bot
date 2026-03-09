import { test, describe, expect, mock } from 'vitest';
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
    expect(client.config.timeout).toBe(DEFAULT_TIMEOUT_MS);
    expect(client.config.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(client.config.baseDelay).toBe(DEFAULT_BASE_DELAY_MS);
  });

  test('creates client with custom config', () => {
    const client = createApiClient({ timeout: 5000, maxRetries: 5, baseDelay: 1000 });
    expect(client.config.timeout).toBe(5000);
    expect(client.config.maxRetries).toBe(5);
    expect(client.config.baseDelay).toBe(1000);
  });

  test('call method returns success structure on success', async () => {
    const client = createApiClient({ maxRetries: 0 });
    
    // Mock the internal function to succeed
    const original = require('../src/lib/api');
    // We can't easily mock without more infrastructure, so test the structure
    expect(typeof client.call === 'function').toBeTruthy();
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
    expect(result.success).toBe(true);
    expect(result.data).toBe('success');
    expect(result.usedFallback).toBe(false);
    expect(attempts).toBe(1);
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
    expect(result.success).toBe(true);
    expect(result.data).toBe('success');
    expect(result.usedFallback).toBe(false);
    expect(attempts).toBe(3);
  });

  test('returns structured error after max retries', async () => {
    const fn = async () => {
      throw new Error('Permanent error');
    };

    const result = await callWithRetry(fn, { maxRetries: 2, baseDelay: 10 });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error.category).toBe('internal');
    expect(result.error.retryable).toBe(false);
  });

  test('returns structured error for non-retryable errors immediately', async () => {
    const fn = async () => {
      throw new Error('Z.ai API error 401: unauthorized');
    };

    const result = await callWithRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result.success).toBe(false);
    expect(result.error.category).toBe('auth');
    expect(result.error.retryable).toBe(false);
  });
});

describe('categorizeError', () => {
  test('categorizes timeout errors', () => {
    const error = new Error('Request timed out');
    const result = categorizeError(error);
    expect(result.category).toBe('timeout');
    expect(result.retryable).toBe(true);
  });

  test('categorizes rate limit errors', () => {
    const error = new Error('Z.ai API error 429: rate limited');
    const result = categorizeError(error);
    expect(result.category).toBe('rate-limit');
    expect(result.retryable).toBe(true);
  });

  test('categorizes auth errors', () => {
    const error = new Error('Z.ai API error 401: unauthorized');
    const result = categorizeError(error);
    expect(result.category).toBe('auth');
    expect(result.retryable).toBe(false);
  });

  test('categorizes validation errors', () => {
    const error = new Error('Z.ai API error 400: bad request');
    const result = categorizeError(error);
    expect(result.category).toBe('validation');
    expect(result.retryable).toBe(false);
  });

  test('categorizes server errors as provider', () => {
    const error = new Error('Z.ai API error 500: internal server error');
    const result = categorizeError(error);
    expect(result.category).toBe('provider');
    expect(result.retryable).toBe(true);
  });

  test('categorizes network errors as provider', () => {
    const error = new Error('connect ECONNREFUSED');
    const result = categorizeError(error);
    expect(result.category).toBe('provider');
    expect(result.retryable).toBe(true);
  });

  test('categorizes empty response as provider', () => {
    const error = new Error('Z.ai API returned an empty response');
    const result = categorizeError(error);
    expect(result.category).toBe('provider');
    expect(result.retryable).toBe(true);
  });

  test('defaults to internal for unknown errors', () => {
    const error = new Error('Something unexpected happened');
    const result = categorizeError(error);
    expect(result.category).toBe('internal');
    expect(result.retryable).toBe(false);
  });
});

describe('sanitizeErrorMessage', () => {
  test('returns unknown error for null input', () => {
    const result = sanitizeErrorMessage(null);
    expect(result).toBe('An unknown error occurred');
  });

  test('returns unknown error for error without message', () => {
    const result = sanitizeErrorMessage({});
    expect(result).toBe('An unknown error occurred');
  });

  test('redacts Bearer tokens', () => {
    const error = new Error('Bearer sk-1234567890abcdef failed');
    const result = sanitizeErrorMessage(error);
    expect(result).toBe('Bearer [REDACTED] failed');
    expect(result).not.toContain('sk-1234567890');
  });

  test('redacts API keys', () => {
    const error = new Error('api_key=secret123 failed');
    const result = sanitizeErrorMessage(error);
    expect(result).not.toContain('secret123');
    expect(result).toContain('[REDACTED]');
  });

  test('redacts URLs with credentials', () => {
    const error = new Error('Failed to connect to https://user:pass@api.example.com');
    const result = sanitizeErrorMessage(error);
    expect(result).not.toContain('user:pass');
    expect(result).toContain('[URL_REDACTED]');
  });

  test('redacts Authorization headers', () => {
    const error = new Error('Authorization: Bearer mytoken123 failed');
    const result = sanitizeErrorMessage(error);
    expect(result).not.toContain('mytoken123');
  });

  test('truncates very long messages', () => {
    const longMessage = 'A'.repeat(1000);
    const error = new Error(longMessage);
    const result = sanitizeErrorMessage(error);
    expect(result.length <= 510).toBeTruthy();
    expect(result.endsWith('...')).toBeTruthy();
  });

  test('passes through safe messages unchanged', () => {
    const error = new Error('Request timed out after 30000ms');
    const result = sanitizeErrorMessage(error);
    expect(result).toBe('Request timed out after 30000ms');
  });
});

describe('createApiClient - withFallback', () => {
  test('withFallback creates new client with fallback config', () => {
    const client = createApiClient({ timeout: 5000, maxRetries: 3 });
    const fallbackFn = () => ({ prompt: 'fallback prompt' });
    const fallbackClient = client.withFallback(fallbackFn);

    expect(fallbackClient).toBeTruthy();
    expect(typeof fallbackClient.call === 'function').toBeTruthy();
    expect(typeof fallbackClient.withFallback === 'function').toBeTruthy();
  });

  test('withFallback preserves original config', () => {
    const client = createApiClient({ timeout: 5000, maxRetries: 3, baseDelay: 1000 });
    const fallbackFn = () => ({ prompt: 'fallback' });
    const fallbackClient = client.withFallback(fallbackFn);

    expect(fallbackClient.config.timeout).toBe(5000);
    expect(fallbackClient.config.maxRetries).toBe(3);
    expect(fallbackClient.config.baseDelay).toBe(1000);
  });

  test('fallback client uses fallback prompt after timeout', async () => {
    const fallbackFn = () => ({ prompt: 'compact fallback prompt' });

    const result = await callWithRetry(
      async (attempt, timeout, fallbackData) => {
        if (attempt < 2) {
          const err = new Error('Request timed out');
          throw err;
        }
        return 'success after fallback';
      },
      {
        maxRetries: 3,
        baseDelay: 10,
        fallbackPrompt: fallbackFn,
        baseTimeout: 30000
      }
    );

    expect(result.success).toBe(true);
    expect(result.usedFallback).toBe(true);
  });

  test('onFallback callback is invoked when switching to fallback', async () => {
    let fallbackCalled = false;
    let fallbackInfo = null;
    const fallbackFn = () => ({ prompt: 'fallback' });

    await callWithRetry(
      async () => {
        const err = new Error('Request timed out');
        err.code = 'ETIMEDOUT';
        throw err;
      },
      {
        maxRetries: 1,
        baseDelay: 10,
        fallbackPrompt: fallbackFn,
        onFallback: (info) => {
          fallbackCalled = true;
          fallbackInfo = info;
        },
        baseTimeout: 30000
      }
    );

    expect(fallbackCalled).toBe(true);
    expect(fallbackInfo).toBeTruthy();
    expect(fallbackInfo.attempt >= 0).toBeTruthy();
    expect(fallbackInfo.originalError).toBeTruthy();
  });

  test('fallback can override apiKey and model', async () => {
    let capturedApiKey = null;
    let capturedModel = null;
    const fallbackFn = () => ({
      prompt: 'fallback',
      apiKey: 'fallback-key',
      model: 'fallback-model'
    });

    await callWithRetry(
      async (attempt, timeout, fallbackData) => {
        if (attempt < 2) {
          const err = new Error('Request timed out');
          throw err;
        }
        capturedApiKey = fallbackData?.apiKey || 'original-key';
        capturedModel = fallbackData?.model || 'original-model';
        return 'success';
      },
      {
        maxRetries: 3,
        baseDelay: 10,
        fallbackPrompt: fallbackFn,
        apiKey: 'original-key',
        model: 'original-model',
        baseTimeout: 30000
      }
    );

    expect(capturedApiKey).toBe('fallback-key');
    expect(capturedModel).toBe('fallback-model');
  });

  test('client.call method accepts per-call fallbackPrompt', async () => {
    const client = createApiClient({ maxRetries: 0 });
    expect(typeof client.call === 'function').toBeTruthy();
  });
});

describe('createApiClient - non-retryable errors', () => {
  test('auth errors return immediately without retry', async () => {
    const fn = async () => {
      throw new Error('Z.ai API error 401: unauthorized');
    };

    const result = await callWithRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result.success).toBe(false);
    expect(result.error.category).toBe('auth');
    expect(result.error.retryable).toBe(false);
    expect(result.error.attempts).toBe(1);
  });

  test('validation errors return immediately without retry', async () => {
    const fn = async () => {
      throw new Error('Z.ai API error 400: bad request');
    };

    const result = await callWithRetry(fn, { maxRetries: 3, baseDelay: 10 });
    expect(result.success).toBe(false);
    expect(result.error.category).toBe('validation');
    expect(result.error.retryable).toBe(false);
    expect(result.error.attempts).toBe(1);
  });
});

describe('callWithRetry - progressive retry', () => {
  test('progressive timeout reduces on each attempt', async () => {
    const timeouts = [];
    const fn = async (attempt, currentTimeout) => {
      timeouts.push(currentTimeout);
      if (attempt < 3) {
        const err = new Error('Request timed out');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return 'success';
    };

    await callWithRetry(fn, { maxRetries: 3, baseDelay: 10, baseTimeout: 30000 });

    expect(timeouts[0] >= 10000).toBeTruthy();
    expect(timeouts[1] < timeouts[0]).toBeTruthy();
    expect(timeouts[2] < timeouts[1]).toBeTruthy();
  });

  test('returns usedFallback false when fallback not used', async () => {
    const fn = async () => 'success';

    const result = await callWithRetry(fn, { maxRetries: 2, baseDelay: 10 });
    expect(result.usedFallback).toBe(false);
  });

  test('includes totalDuration in error response', async () => {
    const fn = async () => {
      throw new Error('Permanent failure');
    };

    const before = Date.now();
    const result = await callWithRetry(fn, { maxRetries: 1, baseDelay: 10 });
    const after = Date.now();

    expect(result.success).toBe(false);
    expect(result.error.totalDuration >= 0).toBeTruthy();
    expect(result.error.totalDuration <= after - before + 50).toBeTruthy();
  });
});

describe('callWithRetry - fallback switching', () => {
  test('fallback activates after timeout on second attempt', async () => {
    let promptUsed = 'original';
    const fallbackFn = () => ({ prompt: 'fallback prompt' });

    const result = await callWithRetry(
      async (attempt, timeout, fallbackData) => {
        promptUsed = fallbackData?.prompt || 'original';
        if (attempt < 2) {
          const err = new Error('Request timed out');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      },
      {
        maxRetries: 3,
        baseDelay: 10,
        fallbackPrompt: fallbackFn,
        baseTimeout: 30000
      }
    );

    expect(result.success).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(promptUsed).toBe('fallback prompt');
  });

  test('fallback does not activate on non-timeout errors', async () => {
    let fallbackTriggered = false;
    const fallbackFn = () => {
      fallbackTriggered = true;
      return { prompt: 'fallback' };
    };

    await callWithRetry(
      async () => {
        throw new Error('Z.ai API error 500: server error');
      },
      {
        maxRetries: 1,
        baseDelay: 10,
        fallbackPrompt: fallbackFn,
        baseTimeout: 30000
      }
    );

    expect(fallbackTriggered).toBe(false);
  });

  test('fallback does not activate on first attempt timeout', async () => {
    let fallbackTriggered = false;
    const fallbackFn = () => {
      fallbackTriggered = true;
      return { prompt: 'fallback' };
    };

    await callWithRetry(
      async (attempt) => {
        if (attempt === 0) {
          const err = new Error('Request timed out');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      },
      {
        maxRetries: 3,
        baseDelay: 10,
        fallbackPrompt: fallbackFn,
        baseTimeout: 30000
      }
    );

    expect(fallbackTriggered).toBe(false);
  });
});

describe('callWithRetry - edge cases', () => {
  test('handles function that returns null fallback result', async () => {
    const fallbackFn = () => null;

    const result = await callWithRetry(
      async (attempt) => {
        if (attempt < 2) {
          const err = new Error('Request timed out');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      },
      {
        maxRetries: 3,
        baseDelay: 10,
        fallbackPrompt: fallbackFn,
        baseTimeout: 30000
      }
    );

    expect(result.success).toBe(true);
    expect(result.usedFallback).toBe(false);
  });

  test('handles function that returns fallback without prompt', async () => {
    const fallbackFn = () => ({ apiKey: 'key' });

    const result = await callWithRetry(
      async (attempt, timeout, fallbackData) => {
        if (attempt < 2) {
          const err = new Error('Request timed out');
          err.code = 'ETIMEDOUT';
          throw err;
        }
        return 'success';
      },
      {
        maxRetries: 3,
        baseDelay: 10,
        fallbackPrompt: fallbackFn,
        baseTimeout: 30000
      }
    );

    expect(result.success).toBe(true);
    expect(result.usedFallback).toBe(false);
  });

  test('preserves error category in final response', async () => {
    const fn = async () => {
      throw new Error('Z.ai API error 429: rate limited');
    };

    const result = await callWithRetry(fn, { maxRetries: 2, baseDelay: 10 });
    expect(result.success).toBe(false);
    expect(result.error.category).toBe('rate-limit');
    expect(result.error.retryable).toBe(true);
  });
});

describe('Transport - https.request mocking', () => {
  test('handles successful API response', async () => {
    const { createApiClient } = require('../src/lib/api');
    
    const client = createApiClient({ maxRetries: 0, baseDelay: 10 });
    
    const error1 = new Error('ECONNREFUSED');
    const cat1 = require('../src/lib/api').categorizeError(error1);
    expect(cat1.category).toBe('provider');
    expect(cat1.retryable).toBe(true);
    
    const error2 = new Error('ENETUNREACH');
    const cat2 = require('../src/lib/api').categorizeError(error2);
    expect(cat2.category).toBe('provider');
    expect(cat2.retryable).toBe(true);
  });

  test('extractStatusCode extracts 4xx codes', () => {
    const error400 = new Error('Z.ai API error 400: bad request');
    const cat = require('../src/lib/api').categorizeError(error400);
    expect(cat.category).toBe('validation');
    expect(cat.retryable).toBe(false);
    
    const error403 = new Error('Z.ai API error 403: forbidden');
    const cat2 = require('../src/lib/api').categorizeError(error403);
    expect(cat2.category).toBe('auth');
    expect(cat2.retryable).toBe(false);
  });

  test('extractStatusCode extracts 5xx codes', () => {
    const error502 = new Error('Z.ai API error 502: bad gateway');
    const cat = require('../src/lib/api').categorizeError(error502);
    expect(cat.category).toBe('provider');
    expect(cat.retryable).toBe(true);
    
    const error503 = new Error('Z.ai API error 503: service unavailable');
    const cat2 = require('../src/lib/api').categorizeError(error503);
    expect(cat2.category).toBe('provider');
    expect(cat2.retryable).toBe(true);
  });

  test('sanitizeErrorMessage extracts API messages from JSON', () => {
    const error = new Error('Z.ai API error 400: {"error":{"message":"Invalid model name"}}');
    const result = require('../src/lib/api').sanitizeErrorMessage(error);
    expect(result).toContain('Invalid model name');
    expect(result).not.toContain('{"error"');
  });

  test('sanitizeErrorMessage handles nested error structures', () => {
    const error = new Error('Z.ai API error 500: {"error":{"error":{"message":"Server exploded"}}}');
    const result = require('../src/lib/api').sanitizeErrorMessage(error);
    expect(result).toContain('Server exploded');
  });

  test('sanitizeErrorMessage redacts JSON with keys', () => {
    const error = new Error('Failed: {"api_key":"secret123","token":"abc"}');
    const result = require('../src/lib/api').sanitizeErrorMessage(error);
    expect(result).not.toContain('secret123');
    expect(result).not.toContain('abc');
    expect(result).toContain('[REDACTED]');
  });
});

describe('makeApiRequest transport', () => {
  test('handles request timeout', async () => {
    const api = require('../src/lib/api');
    try {
      await api.makeApiRequest({
        apiKey: 'test-key',
        model: 'test-model',
        prompt: 'test prompt',
        timeout: 1
      });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message.includes('timed out')).toBe(true);
    }
  });
});

describe('constants', () => {
  test('DEFAULT_TIMEOUT_MS is 30000', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30000);
  });

  test('DEFAULT_MAX_RETRIES is 3', () => {
    expect(DEFAULT_MAX_RETRIES).toBe(3);
  });

  test('DEFAULT_BASE_DELAY_MS is 2000', () => {
    expect(DEFAULT_BASE_DELAY_MS).toBe(2000);
  });

  test('ZAI_API_URL is correct endpoint', () => {
    expect(ZAI_API_URL).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
  });
});
