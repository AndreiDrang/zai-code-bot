/**
 * Logging utilities for Cloudflare Workers
 */

/**
 * Creates a logger instance
 * @param {Object} env - Environment variables
 * @param {string} context - Logging context
 * @returns {Object} - Logger instance
 */
export function createLogger(env, context = 'default') {
  const envName = env.NODE_ENV || 'production';
  
  return {
    /**
     * Logs a message with optional data
     * @param {string} level - Log level (INFO, WARN, ERROR, DEBUG)
     * @param {string} message - Log message
     * @param {Object} data - Additional data
     */
    log: (level, message, data = {}) => {
      const timestamp = new Date().toISOString();
      const logEntry = {
        timestamp,
        level,
        context,
        env: envName,
        message,
        ...data
      };
      
      console.log(JSON.stringify(logEntry));
    },
    
    /**
     * Logs an info message
     */
    info: (message, data = {}) => {
      this.log('INFO', message, data);
    },
    
    /**
     * Logs a warning message
     */
    warn: (message, data = {}) => {
      this.log('WARN', message, data);
    },
    
    /**
     * Logs an error message
     */
    error: (message, data = {}) => {
      this.log('ERROR', message, data);
    },
    
    /**
     * Logs a debug message (only in development)
     */
    debug: (message, data = {}) => {
      if (envName === 'development') {
        this.log('DEBUG', message, data);
      }
    }
  };
}

/**
 * Generates a unique correlation ID
 * @returns {string} - Correlation ID
 */
export function generateCorrelationId() {
  return `zai-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Logs performance metrics
 * @param {Object} env - Environment variables
 * @param {string} operation - Operation name
 * @param {number} startTime - Start timestamp
 * @param {Object} metadata - Additional metadata
 */
export function logPerformance(env, operation, startTime, metadata = {}) {
  const logger = createLogger(env, 'performance');
  const duration = Date.now() - startTime;
  
  logger.info(`${operation} completed`, {
    durationMs: duration,
    ...metadata
  });
}
