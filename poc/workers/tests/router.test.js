import { describe, expect, it } from 'vitest';
import { classifyCommand, getAllCommands } from '../zai-main-worker/src/router.js';
import { AVAILABLE_COMMANDS, HEAVY_COMMANDS, LIGHT_COMMANDS } from '../shared/constants.js';

describe('zai-main-worker/router', () => {
  describe('classifyCommand', () => {
    it.each(LIGHT_COMMANDS.map((c) => [c]))('routes light command %s -> "light"', (cmd) => {
      expect(classifyCommand(cmd)).toBe('light');
    });

    it.each(HEAVY_COMMANDS.map((c) => [c]))('routes heavy command %s -> "heavy"', (cmd) => {
      expect(classifyCommand(cmd)).toBe('heavy');
    });

    it('routes an unknown command to "unsupported"', () => {
      expect(classifyCommand('bogus')).toBe('unsupported');
    });

    it('routes an empty string to "unsupported"', () => {
      expect(classifyCommand('')).toBe('unsupported');
    });
  });

  describe('getAllCommands', () => {
    it('returns the full available command set', () => {
      expect(getAllCommands()).toEqual(AVAILABLE_COMMANDS);
      expect(getAllCommands()).toHaveLength(6);
    });

    it('returns a defensive copy', () => {
      getAllCommands().push('extra');
      expect(getAllCommands()).not.toContain('extra');
    });
  });
});
