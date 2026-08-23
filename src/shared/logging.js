/**
 * Logging utilities for Cloudflare Workers.
 *
 * Historical note: an earlier version returned an object whose `info`/`warn`/
 * `error`/`debug` arrow-function properties called `this.log(...)`, losing the
 * `this` binding and throwing at runtime. This version closes over `log`
 * directly so every method works regardless of call-site `this`.
 */

/**
 * Creates a logger instance.
 * @param {Object} env - Environment variables
 * @param {string} [context='default'] - Logging context
 * @returns {Object} logger with { log, info, warn, error, debug }
 */
export function createLogger(env, context = 'default') {
  const envName = env?.NODE_ENV || 'production';

  const log = (level, message, data = {}) => {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      context,
      env: envName,
      message,
      ...data,
    };
    console.log(JSON.stringify(logEntry));
  };

  return {
    log,
    info: (message, data = {}) => log('INFO', message, data),
    warn: (message, data = {}) => log('WARN', message, data),
    error: (message, data = {}) => log('ERROR', message, data),
    debug: (message, data = {}) => {
      if (envName === 'development') log('DEBUG', message, data);
    },
  };
}

/**
 * Generates a unique correlation ID.
 * @returns {string}
 */
export function generateCorrelationId() {
  return `zai-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Logs performance metrics.
 * @param {Object} env
 * @param {string} operation
 * @param {number} startTime - epoch ms from Date.now()
 * @param {Object} [metadata={}]
 */
export function logPerformance(env, operation, startTime, metadata = {}) {
  const logger = createLogger(env, 'performance');
  logger.info(`${operation} completed`, {
    durationMs: Date.now() - startTime,
    ...metadata,
  });
}
