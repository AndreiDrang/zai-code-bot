/**
 * Hardened API client with timeout, retry, and error handling.
 * Provides reliability improvements for the Z.ai API calls.
 * 
 * Features:
 * - Progressive timeout reduction on retries
 * - Fallback prompt mechanism for early recovery
 * - Detailed timing logs for diagnostics
 */

const https = require('https');

// Default configuration
const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 2000; // 2 seconds

// Progressive timeout multipliers (each retry gets shorter timeout)
// 1st attempt: 100%, 2nd: 67%, 3rd: 50%, 4th: 33%
const PROGRESSIVE_TIMEOUT_MULTIPLIERS = [1.0, 0.67, 0.5, 0.33];
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
  const fallbackPrompt = config.fallbackPrompt ?? null; // Optional fallback prompt generator

  return {
    /**
     * Makes an API call with timeout, retry support, and optional fallback.
     * @param {Object} params - API call parameters
     * @param {string} params.apiKey - API authentication key
     * @param {string} params.model - Model identifier
     * @param {string} params.prompt - Prompt content
     * @param {Function} [params.onFallback] - Optional callback when fallback is triggered
     * @returns {Promise<{success: boolean, data?: string, error?: Object, usedFallback?: boolean}>}
     */
    async call({ apiKey, model, prompt, onFallback, fallbackPrompt: callFallbackPrompt }) {
      const options = { 
        maxRetries, 
        baseDelay, 
        baseTimeout: timeout,
        fallbackPrompt: callFallbackPrompt || fallbackPrompt, // Per-call fallback takes precedence
        onFallback,
        apiKey,
        model
      };

      return callWithRetry(
        (attempt, currentTimeout, fallbackData) => {
          // If fallbackData is provided, use it instead of original prompt
          const actualPrompt = fallbackData?.prompt || prompt;
          const actualApiKey = fallbackData?.apiKey || apiKey;
          const actualModel = fallbackData?.model || model;
          
          return makeApiRequest({ 
            apiKey: actualApiKey, 
            model: actualModel, 
            prompt: actualPrompt, 
            timeout: currentTimeout 
          });
        },
        options
      );
    },

    /**
     * Creates a new client with a fallback prompt generator.
     * The fallback is used after timeout on retry attempts.
     * @param {Function} fallbackFn - Function that returns a compact prompt
     * @returns {Object} New API client with fallback configured
     */
    withFallback(fallbackFn) {
      return createApiClient({
        timeout,
        maxRetries,
        baseDelay,
        fallbackPrompt: fallbackFn
      });
    },

    // Expose config for testing/debugging
    config: { timeout, maxRetries, baseDelay }
  };
}

/**
 * Generic retry wrapper with exponential backoff and progressive timeout.
 * Supports fallback prompt mechanism for early recovery from timeouts.
 * 
 * @param {Function} fn - Async function to execute, receives (attempt, currentTimeout)
 * @param {Object} options - Retry options
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @param {number} [options.baseDelay=2000] - Base delay in milliseconds
 * @param {number} [options.baseTimeout=30000] - Base timeout for first attempt
 * @param {Function} [options.fallbackPrompt] - Generator for fallback prompt
 * @param {Function} [options.onFallback] - Callback when fallback is triggered
 * @returns {Promise<{success: boolean, data?: string, error?: Object, usedFallback?: boolean}>}
 */
async function callWithRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options.baseDelay ?? DEFAULT_BASE_DELAY_MS;
  const baseTimeout = options.baseTimeout ?? DEFAULT_TIMEOUT_MS;
  const fallbackPrompt = options.fallbackPrompt;
  const onFallback = options.onFallback;

  let lastError;
  let usedFallback = false;
  let currentPrompt = null; // Will be set when fallback is used

  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Calculate progressive timeout for this attempt
    const timeoutMultiplier = PROGRESSIVE_TIMEOUT_MULTIPLIERS[Math.min(attempt, PROGRESSIVE_TIMEOUT_MULTIPLIERS.length - 1)];
    const currentTimeout = Math.max(10000, Math.floor(baseTimeout * timeoutMultiplier)); // Minimum 10s

    const attemptStart = Date.now();

    try {
      const result = await fn(attempt, currentTimeout, null); // null = no fallback data
      const attemptDuration = Date.now() - attemptStart;
      const totalDuration = Date.now() - startTime;
      
      // Log successful attempt with timing
      if (typeof process !== 'undefined' && process.env?.ZAI_DEBUG) {
        console.error(`[api.js] Attempt ${attempt + 1} succeeded in ${attemptDuration}ms (total: ${totalDuration}ms, timeout: ${currentTimeout}ms)`);
      }
      
      return {
        success: true,
        data: result,
        usedFallback
      };
    } catch (error) {
      lastError = error;
      const attemptDuration = Date.now() - attemptStart;
      const totalDuration = Date.now() - startTime;
      const categorized = categorizeError(error);

      // Log failed attempt with timing
      if (typeof process !== 'undefined' && process.env?.ZAI_DEBUG) {
        console.error(`[api.js] Attempt ${attempt + 1} failed after ${attemptDuration}ms (total: ${totalDuration}ms, timeout: ${currentTimeout}ms): ${error.message}`);
      }

      // On timeout errors after 2nd attempt, try fallback prompt if available
      if (categorized.category === 'timeout' && attempt >= 1 && fallbackPrompt && !usedFallback) {
        const fallbackResult = fallbackPrompt();
        if (fallbackResult && fallbackResult.prompt) {
          usedFallback = true;
          currentPrompt = fallbackResult.prompt;
          const fallbackData = {
            prompt: fallbackResult.prompt,
            apiKey: fallbackResult.apiKey || options.apiKey,
            model: fallbackResult.model || options.model
          };
          
          // Notify caller that fallback is being used
          if (onFallback) {
            onFallback({ attempt, originalError: error, fallbackInfo: fallbackResult });
          }
          
          // Update fn to pass fallbackData on subsequent calls
          const originalFn = fn;
          fn = (att, timeout, data) => {
            // Always use fallbackData if we've switched to fallback
            return originalFn(att, timeout, fallbackData);
          };
          
          if (typeof process !== 'undefined' && process.env?.ZAI_DEBUG) {
            console.error(`[api.js] Switching to fallback prompt (length: ${currentPrompt.length} chars)`);
          }
        }
      }

      // Don't retry if error is not retryable
      if (!categorized.retryable || attempt >= maxRetries) {
        const finalTotalDuration = Date.now() - startTime;
        return {
          success: false,
          data: null,
          error: {
            category: categorized.category,
            message: sanitizeErrorMessage(error),
            retryable: categorized.retryable,
            attempts: attempt + 1,
            totalDuration: finalTotalDuration
          },
          usedFallback
        };
      }

      // Calculate delay with exponential backoff and jitter
      // delay = baseDelay * 2^attempt + random(0, 1000)
      const delay = baseDelay * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
      
      if (typeof process !== 'undefined' && process.env?.ZAI_DEBUG) {
        console.error(`[api.js] Waiting ${delay}ms before retry ${attempt + 2}`);
      }
      
      await sleep(delay);
    } // end catch block
  } // end for loop

  // Should not reach here, but handle defensively
  const totalDuration = Date.now() - startTime;
  return {
    success: false,
    data: null,
    error: {
      category: 'internal',
      message: sanitizeErrorMessage(lastError),
      retryable: false,
      attempts: maxRetries + 1,
      totalDuration
    },
    usedFallback
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
          // Try to extract meaningful error message from API response
          let errorMsg = `Z.ai API error ${res.statusCode}`;
          try {
            const errorData = JSON.parse(data);
            const apiMessage = errorData?.error?.message ||
                               errorData?.error?.error?.message ||
                               errorData?.message ||
                               null;
            if (apiMessage) {
              errorMsg += `: ${apiMessage}`;
            } else if (data.length < 200) {
              // Include raw data only if short and no message found
              errorMsg += `: ${data}`;
            }
          } catch {
            // JSON parse failed, include raw data if short
            if (data.length < 200) {
              errorMsg += `: ${data}`;
            }
          }
          reject(new Error(errorMsg));
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
 * Removes API keys, tokens, URLs with credentials.
 * Preserves API error messages by extracting them from JSON responses.
 * @param {Error} error - The error to sanitize
 * @returns {string} Safe user-facing message
 */
function sanitizeErrorMessage(error) {
  if (!error || !error.message) {
    return 'An unknown error occurred';
  }

  let message = error.message;

  // Try to extract meaningful error message from JSON response first
  try {
    // Match JSON in error message like: "Z.ai API error 400: {\"error\":...}"
    const jsonMatch = message.match(/:\s*(\{[\s\S]*\})\s*$/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      // Extract nested error message (common patterns)
      const apiMessage = parsed?.error?.message ||
                         parsed?.error?.error?.message ||
                         parsed?.message ||
                         null;
      if (apiMessage && typeof apiMessage === 'string') {
        // Replace the JSON with just the extracted message
        message = message.replace(jsonMatch[0], `: ${apiMessage}`);
      }
    }
  } catch {
    // JSON parsing failed, continue with original message
  }

  // Remove API keys (Bearer tokens, api keys)
  message = message.replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
  message = message.replace(/(api[_-]?key[=:]?\s*)[^\s,}]+/gi, '$1[REDACTED]');
  message = message.replace(/(Authorization:\s*)[^\s]+/gi, '$1[REDACTED]');

  // Remove URLs with potential credentials
  message = message.replace(/https?:\/\/[^\s]*:[^\s@]+@[^\s]*/gi, '[URL_REDACTED]');

  // Remove any remaining JSON-like structures but keep already extracted messages
  // Only target JSON that looks like it might contain keys/tokens
  message = message.replace(/\{[^{}]*"(?:api[_-]?key|token|secret|password|credential)[^"]*"[^{}]*\}/gi, '[REDACTED]');

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
