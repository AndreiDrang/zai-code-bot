/**
 * Hardened API client with timeout, retry, and error handling.
 * Provides reliability improvements for the Z.ai API calls.
 */

const https = require('https');

// Default configuration
const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2000; // 2 seconds

// API endpoint (matching existing implementation)
const ZAI_API_URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions';

/**
 * Error categories for structured logging and handling.
 * @typedef {'auth'|'validation'|'provider'|'rate-limit'|'timeout'|'internal'} ErrorCategory
 */

/**
 * Creates an API client with configurable timeout and retry settings.
 * @param {Object} config - Configuration options
 * @param {number} [config.timeout=30000] - Request timeout in milliseconds
 * @param {number} [config.maxRetries=3] - Maximum number of retry attempts
 * @param {number} [config.baseDelay=2000] - Base delay for exponential backoff in ms
 * @returns {Object} API client with call method
 */
function createApiClient(config = {}) {
  const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = config.baseDelay ?? DEFAULT_BASE_DELAY_MS;

  return {
    /**
     * Makes an API call with timeout and retry support.
     * @param {Object} params - API call parameters
     * @param {string} params.apiKey - API authentication key
     * @param {string} params.model - Model identifier
     * @param {string} params.prompt - Prompt content
     * @returns {Promise<{success: boolean, data?: string, error?: Object}>}
     */
    async call({ apiKey, model, prompt }) {
      const makeRequest = () => makeApiRequest({ apiKey, model, prompt, timeout });
      const options = { maxRetries, baseDelay };

      return callWithRetry(makeRequest, options);
    },

    // Expose config for testing/debugging
    config: { timeout, maxRetries, baseDelay }
  };
}

/**
 * Generic retry wrapper with exponential backoff.
 * @param {Function} fn - Async function to execute
 * @param {Object} options - Retry options
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @param {number} [options.baseDelay=2000] - Base delay in milliseconds
 * @returns {Promise<*>} Result of the function call
 */
async function callWithRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseDelay ?? DEFAULT_BASE_DELAY_MS;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const categorized = categorizeError(error);

      // Don't retry if error is not retryable
      if (!categorized.retryable || attempt >= maxRetries) {
        return {
          success: false,
          error: {
            category: categorized.category,
            message: sanitizeErrorMessage(error),
            retryable: categorized.retryable
          }
        };
      }

      // Calculate delay with exponential backoff and jitter
      // delay = baseDelay * 2^attempt + random(0, 1000)
      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
      await sleep(delay);
    }
  }

  // Should not reach here, but handle defensively
  return {
    success: false,
    error: {
      category: 'internal',
      message: sanitizeErrorMessage(lastError),
      retryable: false
    }
  };
}

/**
 * Makes the actual API request with timeout.
 * @private
 */
function makeApiRequest({ apiKey, model, prompt, timeout }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert code reviewer. Review the provided code changes and give clear, actionable feedback.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const url = new URL(ZAI_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      timeout: timeout,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.message?.content;
            if (!content) {
              reject(new Error(`Z.ai API returned an empty response: ${data}`));
            } else {
              resolve(content);
            }
          } catch (parseError) {
            reject(new Error(`Failed to parse API response: ${parseError.message}`));
          }
        } else {
          reject(new Error(`Z.ai API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Categorizes an error to determine if it's retryable.
 * @param {Error} error - The error to categorize
 * @returns {{category: ErrorCategory, retryable: boolean}}
 */
function categorizeError(error) {
  const message = error.message || '';
  const statusCode = extractStatusCode(message);

  // Timeout errors
  if (message.toLowerCase().includes('timeout') || message.toLowerCase().includes('timed out')) {
    return { category: 'timeout', retryable: true };
  }

  // Network errors
  if (message.toLowerCase().includes('econnrefused') ||
      message.toLowerCase().includes('enetunreach') ||
      message.toLowerCase().includes('ECONNREFUSED') ||
      message.toLowerCase().includes('ENETUNREACH')) {
    return { category: 'provider', retryable: true };
  }

  // Rate limiting (429)
  if (statusCode === 429) {
    return { category: 'rate-limit', retryable: true };
  }

  // Authentication errors (401, 403)
  if (statusCode === 401 || statusCode === 403) {
    return { category: 'auth', retryable: false };
  }

  // Validation errors (400)
  if (statusCode === 400) {
    return { category: 'validation', retryable: false };
  }

  // Server errors (5xx)
  if (statusCode >= 500 && statusCode < 600) {
    return { category: 'provider', retryable: true };
  }

  // Empty response
  if (message.includes('empty response') || message.includes('returned an empty response')) {
    return { category: 'provider', retryable: true };
  }

  // Default to internal/unknown
  return { category: 'internal', retryable: false };
}

/**
 * Extracts HTTP status code from error message.
 * @private
 */
function extractStatusCode(message) {
  const match = message.match(/\b([45]\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Sanitizes error message to prevent secret leakage.
 * Removes API keys, tokens, URLs with credentials, and raw provider responses.
 * @param {Error} error - The error to sanitize
 * @returns {string} Safe user-facing message
 */
function sanitizeErrorMessage(error) {
  if (!error || !error.message) {
    return 'An unknown error occurred';
  }

  let message = error.message;

  // Remove API keys (Bearer tokens, api keys)
  message = message.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
  message = message.replace(/(api[_-]?key[=:]?\s*)[^\s,}]+/gi, '$1[REDACTED]');
  message = message.replace(/(Authorization:\s*)[^\s]+/gi, '$1[REDACTED]');

  // Remove URLs with potential credentials
  message = message.replace(/https?:\/\/[^\s]*:[^\s@]+@[^\s]*/gi, '[URL_REDACTED]');

  // Remove JSON-like content that might contain sensitive data
  // This catches raw API response bodies
  message = message.replace(/\{[^{}]*"[a-zA-Z_]*"\s*:\s*"[^"]*"[^{}]*\}/g, '[DATA_REDACTED]');

  // Truncate very long error messages that might contain dump
  if (message.length > 500) {
    message = message.substring(0, 500) + '...';
  }

  return message;
}

/**
 * Sleep utility for retry delays.
 * @private
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  createApiClient,
  callWithRetry,
  categorizeError,
  sanitizeErrorMessage,
  ZAI_API_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BASE_DELAY_MS
};
