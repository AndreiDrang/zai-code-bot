import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, generateCorrelationId, logPerformance } from '../shared/logging.js';

describe('shared/logging', () => {
  let logSpy;
  afterEach(() => vi.restoreAllMocks());

  describe('createLogger', () => {
    it('exposes log/info/warn/error/debug that do not throw (historical this-binding bug fixed)', () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const logger = createLogger({ NODE_ENV: 'development' }, 'ctx');
      expect(() => {
        logger.log('INFO', 'm');
        logger.info('m');
        logger.warn('m');
        logger.error('m');
        logger.debug('m');
      }).not.toThrow();
      expect(logSpy).toHaveBeenCalledTimes(5);
    });

    it('writes a structured JSON log entry via console.log', () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      createLogger({}, 'webhook').info('received', { id: 1 });
      expect(logSpy).toHaveBeenCalledOnce();
      const entry = JSON.parse(logSpy.mock.calls[0][0]);
      expect(entry).toMatchObject({
        level: 'INFO',
        context: 'webhook',
        env: 'production',
        message: 'received',
        id: 1,
      });
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('emits DEBUG entries only in development', () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      createLogger({ NODE_ENV: 'development' }).debug('d');
      createLogger({ NODE_ENV: 'production' }).debug('d');
      expect(logSpy).toHaveBeenCalledOnce();
    });

    it('lets no data key overwrite the reserved envelope keys', () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      createLogger({}, 'ctx').info('label', {
        message: 'collision',
        level: 'FAKE',
        timestamp: 'not-a-time',
        context: 'fake',
        env: 'fake',
      });
      const entry = JSON.parse(logSpy.mock.calls[0][0]);
      expect(entry.message).toBe('label');
      expect(entry.level).toBe('INFO');
      expect(entry.context).toBe('ctx');
      expect(entry.env).toBe('production');
      expect(entry.timestamp).not.toBe('not-a-time');
    });

    it('still spreads ordinary data keys through, including error detail keys', () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      createLogger({}, 'ctx').error('boom', { errorMessage: 'raw detail', errorCode: 'x1' });
      const entry = JSON.parse(logSpy.mock.calls[0][0]);
      expect(entry.message).toBe('boom');
      expect(entry.errorMessage).toBe('raw detail');
      expect(entry.errorCode).toBe('x1');
    });

    it('defaults context to "default" when omitted', () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      createLogger({}).info('m');
      expect(JSON.parse(logSpy.mock.calls[0][0]).context).toBe('default');
    });

    it('defaults env to "production" when NODE_ENV is absent', () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      createLogger({}).info('m');
      expect(JSON.parse(logSpy.mock.calls[0][0]).env).toBe('production');
    });
  });

  describe('generateCorrelationId', () => {
    it('returns a zai-prefixed id with three segments', () => {
      expect(generateCorrelationId()).toMatch(/^zai-\d+-[a-z0-9]+$/);
    });

    it('generates unique values across many calls', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateCorrelationId()));
      expect(ids.size).toBe(50);
    });
  });

  describe('logPerformance', () => {
    it('logs the operation with a non-negative durationMs and merged metadata', () => {
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      logPerformance({}, 'op', Date.now(), { extra: 1 });
      const entry = JSON.parse(logSpy.mock.calls[0][0]);
      expect(entry.message).toBe('op completed');
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry.extra).toBe(1);
    });
  });
});
