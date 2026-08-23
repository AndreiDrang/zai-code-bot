import { describe, expect, it } from 'vitest';
import { resolveSecretValue } from '../shared/secrets.js';

describe('shared/secrets (Secrets Store binding resolver)', () => {
  it('passes a plain string through', async () => {
    expect(await resolveSecretValue('hunter2')).toBe('hunter2');
  });

  it('trims surrounding whitespace', async () => {
    expect(await resolveSecretValue('  hunter2 ')).toBe('hunter2');
  });

  it.each([
    ['empty string', ''],
    ['whitespace-only', '   '],
    ['undefined', undefined],
    ['null', null],
    ['number', 123],
    ['boolean', true],
    ['plain object without get/then', {}],
    ['array', [1, 2, 3]],
  ])('returns undefined for %s', async (_label, input) => {
    expect(await resolveSecretValue(input)).toBeUndefined();
  });

  describe('{ get(): Promise<string> } binding shape', () => {
    it('resolves to the string value', async () => {
      expect(await resolveSecretValue({ get: async () => 'tok-from-get' })).toBe('tok-from-get');
    });

    it('trims the resolved value', async () => {
      expect(await resolveSecretValue({ get: async () => '  tok  ' })).toBe('tok');
    });

    it('returns undefined when get() resolves to empty', async () => {
      expect(await resolveSecretValue({ get: async () => '' })).toBeUndefined();
    });

    it('returns undefined when get() resolves to a non-string', async () => {
      expect(await resolveSecretValue({ get: async () => 42 })).toBeUndefined();
    });

    it('treats a TypeError from get() as a missing secret (not a crash)', async () => {
      const binding = {
        get: async () => {
          throw new TypeError('not a getter');
        },
      };
      expect(await resolveSecretValue(binding)).toBeUndefined();
    });

    it('propagates non-TypeError failures from get()', async () => {
      const binding = {
        get: async () => {
          throw new Error('real secret-store failure');
        },
      };
      await expect(resolveSecretValue(binding)).rejects.toThrow('real secret-store failure');
    });
  });

  describe('thenable / Promise<string> binding shape', () => {
    it('resolves a Promise<string>', async () => {
      expect(await resolveSecretValue(Promise.resolve('tok-from-promise'))).toBe(
        'tok-from-promise',
      );
    });

    it('returns undefined when the Promise resolves to empty', async () => {
      expect(await resolveSecretValue(Promise.resolve(''))).toBeUndefined();
    });

    it('returns undefined when the Promise rejects', async () => {
      expect(await resolveSecretValue(Promise.reject(new Error('nope')))).toBeUndefined();
    });
  });
});
