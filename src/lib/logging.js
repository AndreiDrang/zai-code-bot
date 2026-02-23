/**
 * Structured logging and error taxonomy for Z.ai Code Review
 * Provides correlation IDs, standardized log fields, and user-safe error messages
 */

const core = require('@actions/core');

/**
 * Error categories for classification
 * @readonly
 * @enum {string}
 */
const ERROR_CATEGORIES = {
  /** Authentication/authorization failures */
  AUTH: 'AUTH',
  /** Input validation failures */
  VALIDATION: 'VALIDATION',
  /** External provider/API failures */
  PROVIDER: 'PROVIDER',
  /** Rate limiting errors */
  RATE_LIMIT: 'RATE_LIMIT',
  /** Timeout errors */
  TIMEOUT: 'TIMEOUT',
  /** Internal/unexpected errors */
  INTERNAL: 'INTERNAL',
};

/**
 * Fields that should be redacted from logs to prevent secret leakage
 */
const REDACT_FIELDS = [
  'ZAI_API_KEY',
  'GITHUB_TOKEN',
  'authorization',
  'Authorization',
  'Bearer',
  'token',
  'api_key',
  'apikey',
  'secret',
  'password',
  'credential',
];

/**
 * Mapping from internal error categories to user-safe messages
 * These messages are designed to be displayed to end users
 * without exposing internal implementation details
 */
const USER_MESSAGES = {
  [ERROR_CATEGORIES.AUTH]: 'Authentication failed. Please verify your API credentials.',
  [ERROR_CATEGORIES.VALIDATION]: 'Invalid input provided. Please check your action configuration.',
  [ERROR_CATEGORIES.PROVIDER]: 'External service request failed. Please try again later.',
  [ERROR_CATEGORIES.RATE_LIMIT]: 'Rate limit exceeded. Please wait before retrying.',
  [ERROR_CATEGORIES.TIMEOUT]: 'Request timed out. Please try again.',
  [ERROR_CATEGORIES.INTERNAL]: 'An unexpected error occurred. Please try again.',
};

/**
 * Fields that should always be included in log context
 */
const STANDARD_FIELDS = [
  'correlationId',
  'eventName',
  'prNumber',
  'command',
  'duration',
];

/**
 * Generates a unique correlation ID for event tracking
 * Format: timestamp-randomhex (e.g., "1700000000-a1b2c3d4")
 * @returns {string} Unique correlation ID
 */
function generateCorrelationId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}-${random}`;
}

/**
 * Redacts sensitive fields from an object for safe logging
 * @param {Object} data - Data object to redact
 * @returns {Object} Data with sensitive fields redacted
 */
function redactSensitiveData(data) {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data !== 'object') {
    return data;
  }

  const redacted = Array.isArray(data) ? [] : {};
  
  for (const [key, value] of Object.entries(data)) {
    const shouldRedact = REDACT_FIELDS.some(
      field => key.toLowerCase().includes(field.toLowerCase())
    );
    
    if (shouldRedact) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveData(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Formats log data as a JSON-ish string for easier parsing
 * @param {Object} fields - Log fields
 * @returns {string} Formatted log string
 */
function formatLogData(fields) {
  const safeFields = redactSensitiveData(fields);
  const entries = Object.entries(safeFields)
    .filter(([_, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      const formatted = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}=${formatted}`;
    });
  return entries.join(' ');
}

/**
 * Creates a logger instance with context fields
 * @param {string} correlationId - Unique event correlation ID
 * @param {Object} context - Context fields (eventName, prNumber, command, etc.)
 * @returns {Object} Logger instance with info, warn, error methods
 */
function createLogger(correlationId, context = {}) {
  const baseContext = {
    correlationId,
    ...context,
  };

  return {
    /**
     * Log informational message
     * @param {Object} fields - Additional fields to log
     * @param {string} message - Log message
     */
    info(fields = {}, message) {
      const logData = {
        ...baseContext,
        ...fields,
        timestamp: new Date().toISOString(),
      };
      core.info(formatLogData(logData) + (message ? ` ${message}` : ''));
    },

    /**
     * Log warning message
     * @param {Object} fields - Additional fields to log
     * @param {string} message - Log message
     */
    warn(fields = {}, message) {
      const logData = {
        ...baseContext,
        ...fields,
        timestamp: new Date().toISOString(),
      };
      core.warning(formatLogData(logData) + (message ? ` ${message}` : ''));
    },

    /**
     * Log error message
     * @param {Object} fields - Additional fields to log
     * @param {string} message - Log message
     */
    error(fields = {}, message) {
      const logData = {
        ...baseContext,
        ...fields,
        timestamp: new Date().toISOString(),
      };
      core.error(formatLogData(logData) + (message ? ` ${message}` : ''));
    },

    /**
     * Set failure status with user-safe message
     * @param {Object} fields - Additional fields to log
     * @param {string} message - User-safe message
     */
    setFailed(fields = {}, message) {
      const logData = {
        ...baseContext,
        ...fields,
        timestamp: new Date().toISOString(),
      };
      core.setFailed(formatLogData(logData) + (message ? ` ${message}` : ''));
    },
  };
}

/**
 * Maps internal errors to user-safe messages
 * @param {string} category - Error category from ERROR_CATEGORIES
 * @param {Error} [internalError] - Original error (not exposed to users)
 * @returns {string} User-safe message
 */
function getUserMessage(category, internalError = null) {
  const message = USER_MESSAGES[category] || USER_MESSAGES[ERROR_CATEGORIES.INTERNAL];
  
  // Log the internal error details separately for debugging
  if (internalError) {
    const internalLogger = createLogger(generateCorrelationId());
    internalLogger.error(
      { category, errorType: internalError.name },
      `Internal error: ${internalError.message}`
    );
  }
  
  return message;
}

/**
 * Categorizes an error based on its characteristics
 * @param {Error} error - Error to categorize
 * @returns {string} Error category from ERROR_CATEGORIES
 */
function categorizeError(error) {
  const message = error.message?.toLowerCase() || '';

  // Auth errors
  if (
    message.includes('auth') ||
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('invalid token') ||
    message.includes('401') ||
    message.includes('403')
  ) {
    return ERROR_CATEGORIES.AUTH;
  }

  // Rate limit errors
  if (
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('429')
  ) {
    return ERROR_CATEGORIES.RATE_LIMIT;
  }

  // Timeout errors
  if (
    message.includes('timeout') ||
    message.includes('etimedout') ||
    message.includes('timed out')
  ) {
    return ERROR_CATEGORIES.TIMEOUT;
  }

  // Validation errors
  if (
    message.includes('validation') ||
    message.includes('invalid input') ||
    message.includes('required') ||
    message.includes('schema')
  ) {
    return ERROR_CATEGORIES.VALIDATION;
  }

  // Provider errors (external API failures)
  if (
    message.includes('api') ||
    message.includes('provider') ||
    message.includes('external') ||
    message.includes('5')
  ) {
    return ERROR_CATEGORIES.PROVIDER;
  }

  // Default to internal
  return ERROR_CATEGORIES.INTERNAL;
}

module.exports = {
  ERROR_CATEGORIES,
  REDACT_FIELDS,
  STANDARD_FIELDS,
  generateCorrelationId,
  createLogger,
  getUserMessage,
  categorizeError,
  redactSensitiveData,
};
