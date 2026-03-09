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
    expect(id1).not.toBe(id2);
  });

  it('contains timestamp component', () => {
    const id = generateCorrelationId();
    const timestampPart = id.split('-')[0];
    const timestamp = parseInt(timestampPart, 36);
    expect(timestamp > 0).toBeTruthy();
  });

  it('has correct format timestamp-random', () => {
    const id = generateCorrelationId();
    const parts = id.split('-');
    expect(parts.length).toBe(2);
    expect(parts[0].length > 0).toBeTruthy();
    expect(parts[1].length > 0).toBeTruthy();
  });
});

describe('ERROR_CATEGORIES', () => {
  it('contains all required categories', () => {
    expect(ERROR_CATEGORIES.AUTH).toBe('AUTH');
    expect(ERROR_CATEGORIES.VALIDATION).toBe('VALIDATION');
    expect(ERROR_CATEGORIES.PROVIDER).toBe('PROVIDER');
    expect(ERROR_CATEGORIES.RATE_LIMIT).toBe('RATE_LIMIT');
    expect(ERROR_CATEGORIES.TIMEOUT).toBe('TIMEOUT');
    expect(ERROR_CATEGORIES.INTERNAL).toBe('INTERNAL');
  });
});

describe('REDACT_FIELDS', () => {
  it('includes API key field', () => {
    expect(REDACT_FIELDS.includes('ZAI_API_KEY')).toBe(true);
  });

  it('includes token field', () => {
    expect(REDACT_FIELDS.includes('GITHUB_TOKEN')).toBe(true);
  });

  it('includes authorization header', () => {
    expect(REDACT_FIELDS.includes('authorization')).toBe(true);
  });
});

describe('createLogger', () => {
  it('creates logger with correlation ID', () => {
    const logger = createLogger('test-correlation-id', {});
    expect(logger).toBeTruthy();
    expect(typeof logger.info === 'function').toBeTruthy();
    expect(typeof logger.warn === 'function').toBeTruthy();
    expect(typeof logger.error === 'function').toBeTruthy();
    expect(typeof logger.setFailed === 'function').toBeTruthy();
  });

  it('accepts context fields', () => {
    const logger = createLogger('corr-id-123', { prNumber: 42, eventName: 'pull_request' });
    expect(logger.info !== undefined).toBeTruthy();
    expect(logger.warn !== undefined).toBeTruthy();
    expect(logger.error !== undefined).toBeTruthy();
    expect(logger.setFailed !== undefined).toBeTruthy();
  });
});

describe('redactSensitiveData', () => {
  it('returns null/undefined as-is', () => {
    expect(redactSensitiveData(null)).toBe(null);
    expect(redactSensitiveData(undefined)).toBe(undefined);
  });

  it('returns primitives as-is', () => {
    expect(redactSensitiveData('string')).toBe('string');
    expect(redactSensitiveData(123)).toBe(123);
    expect(redactSensitiveData(true)).toBe(true);
  });

  it('redacts ZAI_API_KEY', () => {
    const data = { ZAI_API_KEY: 'secret-key', name: 'test' };
    const redacted = redactSensitiveData(data);
    expect(redacted.ZAI_API_KEY).toBe('[REDACTED]');
    expect(redacted.name).toBe('test');
  });

  it('redacts GITHUB_TOKEN', () => {
    const data = { GITHUB_TOKEN: 'ghp_xxx', other: 'value' };
    const redacted = redactSensitiveData(data);
    expect(redacted.GITHUB_TOKEN).toBe('[REDACTED]');
    expect(redacted.other).toBe('value');
  });

  it('redacts nested sensitive fields', () => {
    const data = {
      auth: {
        token: 'nested-secret',
        name: 'test',
      },
    };
    const redacted = redactSensitiveData(data);
    expect(redacted.auth.token).toBe('[REDACTED]');
    expect(redacted.auth.name).toBe('test');
  });

  it('handles arrays', () => {
    const data = [{ token: 'secret1' }, { token: 'secret2' }];
    const redacted = redactSensitiveData(data);
    expect(redacted[0].token).toBe('[REDACTED]');
    expect(redacted[1].token).toBe('[REDACTED]');
  });

  it('is case-insensitive for field matching', () => {
    const data = { AUTHORIZATION: 'Bearer xxx', 'Authorization': 'Bearer yyy' };
    const redacted = redactSensitiveData(data);
    expect(redacted.AUTHORIZATION).toBe('[REDACTED]');
    expect(redacted.Authorization).toBe('[REDACTED]');
  });
});

describe('getUserMessage', () => {
  it('returns auth message for AUTH category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.AUTH);
    expect(msg.includes('Authentication failed')).toBe(true);
  });

  it('returns validation message for VALIDATION category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.VALIDATION);
    expect(msg.includes('Invalid input')).toBe(true);
  });

  it('returns provider message for PROVIDER category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.PROVIDER);
    expect(msg.includes('External service')).toBe(true);
  });

  it('returns rate limit message for RATE_LIMIT category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.RATE_LIMIT);
    expect(msg.includes('Rate limit')).toBe(true);
  });

  it('returns timeout message for TIMEOUT category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.TIMEOUT);
    expect(msg.includes('timed out')).toBe(true);
  });

  it('returns internal message for INTERNAL category', () => {
    const msg = getUserMessage(ERROR_CATEGORIES.INTERNAL);
    expect(msg.includes('unexpected error')).toBe(true);
  });

  it('falls back to internal message for unknown category', () => {
    const msg = getUserMessage('UNKNOWN_CATEGORY');
    expect(msg.includes('unexpected error')).toBe(true);
  });
});

describe('categorizeError', () => {
  it('categorizes auth errors', () => {
    const error = new Error('401 unauthorized');
    expect(categorizeError(error)).toBe(ERROR_CATEGORIES.AUTH);
  });

  it('categorizes rate limit errors', () => {
    const error = new Error('rate limit exceeded');
    expect(categorizeError(error)).toBe(ERROR_CATEGORIES.RATE_LIMIT);
  });

  it('categorizes timeout errors', () => {
    const error = new Error('ETIMEDOUT connection timeout');
    expect(categorizeError(error)).toBe(ERROR_CATEGORIES.TIMEOUT);
  });

  it('categorizes validation errors', () => {
    const error = new Error('input validation failed');
    expect(categorizeError(error)).toBe(ERROR_CATEGORIES.VALIDATION);
  });

  it('categorizes provider errors', () => {
    const error = new Error('external API error 500');
    expect(categorizeError(error)).toBe(ERROR_CATEGORIES.PROVIDER);
  });

  it('defaults to internal for unknown errors', () => {
    const error = new Error('something went wrong');
    expect(categorizeError(error)).toBe(ERROR_CATEGORIES.INTERNAL);
  });

  it('detects auth from forbidden message', () => {
    const error = new Error('access forbidden');
    expect(categorizeError(error)).toBe(ERROR_CATEGORIES.AUTH);
  });

  it('detects rate limit from 429', () => {
    const error = new Error('error 429 too many requests');
    expect(categorizeError(error)).toBe(ERROR_CATEGORIES.RATE_LIMIT);
  });
});

describe('STANDARD_FIELDS', () => {
  it('includes correlationId', () => {
    expect(STANDARD_FIELDS.includes('correlationId')).toBe(true);
  });

  it('includes eventName', () => {
    expect(STANDARD_FIELDS.includes('eventName')).toBe(true);
  });

  it('includes prNumber', () => {
    expect(STANDARD_FIELDS.includes('prNumber')).toBe(true);
  });

  it('includes command', () => {
    expect(STANDARD_FIELDS.includes('command')).toBe(true);
  });

  it('includes duration', () => {
    expect(STANDARD_FIELDS.includes('duration')).toBe(true);
  });
});
