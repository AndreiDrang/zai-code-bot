const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const {
  ERROR_CATEGORIES,
  REDACT_FIELDS,
  STANDARD_FIELDS,
  generateCorrelationId,
  createLogger,
  getUserMessage,
  categorizeError,
  redactSensitiveData,
} = require('../src/lib/logging.js');

describe('generateCorrelationId', () => {
  it('generates unique IDs', () => {
    const id1 = generateCorrelationId();
    const id2 = generateCorrelationId();
    assert.notStrictEqual(id1, id2);
  });

  it('contains timestamp component', () => {
    const id = generateCorrelationId();
    const timestampPart = id.split('-')[0];
    const timestamp = parseInt(timestampPart, 36);
    assert.ok(timestamp > 0);
  });

  it('has correct format timestamp-random', () => {
    const id = generateCorrelationId();
    const parts = id.split('-');
    assert.strictEqual(parts.length, 2);
    assert.ok(parts[0].length > 0);
    assert.ok(parts[1].length > 0);
  });
});

describe('ERROR_CATEGORIES', () => {
  it('contains all required categories', () => {
    assert.strictEqual(ERROR_CATEGORIES.AUTH, 'AUTH');
    assert.strictEqual(ERROR_CATEGORIES.VALIDATION, 'VALIDATION');
    assert.strictEqual(ERROR_CATEGORIES.PROVIDER, 'PROVIDER');
    assert.strictEqual(ERROR_CATEGORIES.RATE_LIMIT, 'RATE_LIMIT');
    assert.strictEqual(ERROR_CATEGORIES.TIMEOUT, 'TIMEOUT');
    assert.strictEqual(ERROR_CATEGORIES.INTERNAL, 'INTERNAL');
  });
});

describe('REDACT_FIELDS', () => {
  it('includes API key field', () => {
    assert.ok(REDACT_FIELDS.includes('ZAI_API_KEY'));
  });

  it('includes token field', () => {
    assert.ok(REDACT_FIELDS.includes('GITHUB_TOKEN'));
  });

  it('includes authorization header', () => {
    assert.ok(REDACT_FIELDS.includes('authorization'));
  });
});

describe('createLogger', () => {
  it('creates logger with correlation ID', () => {
    const logger = createLogger('test-correlation-id', {});
    assert.ok(logger);
    assert.ok(typeof logger.info === 'function');
    assert.ok(typeof logger.warn === 'function');
    assert.ok(typeof logger.error === 'function');
    assert.ok(typeof logger.setFailed === 'function');
  });

  it('accepts context fields', () => {
    const logger = createLogger('corr-id-123', { prNumber: 42, eventName: 'pull_request' });
    assert.ok(logger.info !== undefined);
    assert.ok(logger.warn !== undefined);
    assert.ok(logger.error !== undefined);
    assert.ok(logger.setFailed !== undefined);
  });
});

describe('redactSensitiveData', () => {
  it('returns null/undefined as-is', () => {
    assert.strictEqual(redactSensitiveData(null), null);
    assert.strictEqual(redactSensitiveData(undefined), undefined);
  });

  it('returns primitives as-is', () => {
    assert.strictEqual(redactSensitiveData('string'), 'string');
    assert.strictEqual(redactSensitiveData(123), 123);
    assert.strictEqual(redactSensitiveData(true), true);
  });

  it('redacts ZAI_API_KEY', () => {
    const data = { ZAI_API_KEY: 'secret-key', name: 'test' };
    const redacted = redactSensitiveData(data);
    assert.strictEqual(redacted.ZAI_API_KEY, '[REDACTED]');
    assert.strictEqual(redacted.name, 'test');
  });

  it('redacts GITHUB_TOKEN', () => {
    const data = { GITHUB_TOKEN: 'ghp_xxx', other: 'value' };
    const redacted = redactSensitiveData(data);
    assert.strictEqual(redacted.GITHUB_TOKEN, '[REDACTED]');
    assert.strictEqual(redacted.other, 'value');
  });

  it('redacts nested sensitive fields', () => {
    const data = {
      auth: {
        token: 'nested-secret',
        name: 'test',
      },
    };
    const redacted = redactSensitiveData(data);
    assert.strictEqual(redacted.auth.token, '[REDACTED]');
    assert.strictEqual(redacted.auth.name, 'test');
  });

  it('handles arrays', () => {
    const data = [{ token: 'secret1' }, { token: 'secret2' }];
    const redacted = redactSensitiveData(data);
    assert.strictEqual(redacted[0].token, '[REDACTED]');
    assert.strictEqual(redacted[1].token, '[REDACTED]');
  });

  it('is case-insensitive for field matching', () => {
    const data = { AUTHORIZATION: 'Bearer xxx', 'Authorization': 'Bearer yyy' };
    const redacted = redactSensitiveData(data);
    assert.strictEqual(redacted.AUTHORIZATION, '[REDACTED]');
    assert.strictEqual(redacted.Authorization, '[REDACTED]');
  });
});

describe('getUserMessage', () => {
  it('returns auth message for AUTH category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.AUTH);
    assert.ok(msg.includes('Authentication failed'));
  });

  it('returns validation message for VALIDATION category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.VALIDATION);
    assert.ok(msg.includes('Invalid input'));
  });

  it('returns provider message for PROVIDER category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.PROVIDER);
    assert.ok(msg.includes('External service'));
  });

  it('returns rate limit message for RATE_LIMIT category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.RATE_LIMIT);
    assert.ok(msg.includes('Rate limit'));
  });

  it('returns timeout message for TIMEOUT category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.TIMEOUT);
    assert.ok(msg.includes('timed out'));
  });

  it('returns internal message for INTERNAL category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.INTERNAL);
    assert.ok(msg.includes('unexpected error'));
  });

  it('falls back to internal message for unknown category', () => {
    const msg = getUserMessage('UNKNOWN_CATEGORY');
    assert.ok(msg.includes('unexpected error'));
  });
});

describe('categorizeError', () => {
  it('categorizes auth errors', () => {
    const error = new Error('401 unauthorized');
    assert.strictEqual(categorizeError(error), ERROR_CATEGORIES.AUTH);
  });

  it('categorizes rate limit errors', () => {
    const error = new Error('rate limit exceeded');
    assert.strictEqual(categorizeError(error), ERROR_CATEGORIES.RATE_LIMIT);
  });

  it('categorizes timeout errors', () => {
    const error = new Error('ETIMEDOUT connection timeout');
    assert.strictEqual(categorizeError(error), ERROR_CATEGORIES.TIMEOUT);
  });

  it('categorizes validation errors', () => {
    const error = new Error('input validation failed');
    assert.strictEqual(categorizeError(error), ERROR_CATEGORIES.VALIDATION);
  });

  it('categorizes provider errors', () => {
    const error = new Error('external API error 500');
    assert.strictEqual(categorizeError(error), ERROR_CATEGORIES.PROVIDER);
  });

  it('defaults to internal for unknown errors', () => {
    const error = new Error('something went wrong');
    assert.strictEqual(categorizeError(error), ERROR_CATEGORIES.INTERNAL);
  });

  it('detects auth from forbidden message', () => {
    const error = new Error('access forbidden');
    assert.strictEqual(categorizeError(error), ERROR_CATEGORIES.AUTH);
  });

  it('detects rate limit from 429', () => {
    const error = new Error('error 429 too many requests');
    assert.strictEqual(categorizeError(error), ERROR_CATEGORIES.RATE_LIMIT);
  });
});

describe('STANDARD_FIELDS', () => {
  it('includes correlationId', () => {
    assert.ok(STANDARD_FIELDS.includes('correlationId'));
  });

  it('includes eventName', () => {
    assert.ok(STANDARD_FIELDS.includes('eventName'));
  });

  it('includes prNumber', () => {
    assert.ok(STANDARD_FIELDS.includes('prNumber'));
  });

  it('includes command', () => {
    assert.ok(STANDARD_FIELDS.includes('command'));
  });

  it('includes duration', () => {
    assert.ok(STANDARD_FIELDS.includes('duration'));
  });
});
