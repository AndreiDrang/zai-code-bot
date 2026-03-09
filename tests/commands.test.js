import { test, describe, expect } from 'vitest';
const { parseCommand, normalizeInput, isValid, ALLOWED_COMMANDS, ERROR_TYPES } = require('../src/lib/commands.js');

describe('parseCommand', () => {
  test('parses valid /zai ask command', () => {
    const result = parseCommand('/zai ask what is this function doing?');
    expect(result.command).toBe('ask');
    expect(result.args).toEqual(['what', 'is', 'this', 'function', 'doing?']);
    expect(result.raw).toBe('/zai ask what is this function doing?');
    expect(result.error).toBe(null);
    expect(isValid(result)).toBe(true);
  });

  test('parses valid /zai review command', () => {
    const result = parseCommand('/zai review src/utils.ts');
    expect(result.command).toBe('review');
    expect(result.args).toEqual(['src/utils.ts']);
    expect(result.error).toBe(null);
  });

  test('parses valid /zai explain command', () => {
    const result = parseCommand('/zai explain 10-15');
    expect(result.command).toBe('explain');
    expect(result.args).toEqual(['10-15']);
    expect(result.error).toBe(null);
  });

  test('returns unknown_command error for /zai suggest (removed command)', () => {
    const result = parseCommand('/zai suggest better naming');
    expect(result.error.type).toBe(ERROR_TYPES.UNKNOWN_COMMAND);
    expect(result.error.message).toBe('Unknown command: suggest');
    expect(isValid(result)).toBe(false);
  });

  test('returns unknown_command error for /zai compare (removed command)', () => {
    const result = parseCommand('/zai compare');
    expect(result.error.type).toBe(ERROR_TYPES.UNKNOWN_COMMAND);
    expect(result.error.message).toBe('Unknown command: compare');
    expect(isValid(result)).toBe(false);
  });

  test('parses valid /zai help command', () => {
    const result = parseCommand('/zai help');
    expect(result.command).toBe('help');
    expect(result.args).toEqual([]);
    expect(result.error).toBe(null);
  });

  test('returns empty_input error for null input', () => {
    const result = parseCommand(null);
    expect(result.command).toBe(null);
    expect(result.args).toEqual([]);
    expect(result.error.type).toBe(ERROR_TYPES.EMPTY_INPUT);
    expect(isValid(result)).toBe(false);
  });

  test('returns empty_input error for undefined input', () => {
    const result = parseCommand(undefined);
    expect(result.error.type).toBe(ERROR_TYPES.EMPTY_INPUT);
    expect(isValid(result)).toBe(false);
  });

  test('returns empty_input error for empty string', () => {
    const result = parseCommand('');
    expect(result.error.type).toBe(ERROR_TYPES.EMPTY_INPUT);
    expect(isValid(result)).toBe(false);
  });

  test('returns empty_input error for whitespace-only string', () => {
    const result = parseCommand('   ');
    expect(result.error.type).toBe(ERROR_TYPES.EMPTY_INPUT);
    expect(isValid(result)).toBe(false);
  });

  test('returns malformed_input error for input without /zai', () => {
    const result = parseCommand('hello world');
    expect(result.error.type).toBe(ERROR_TYPES.MALFORMED_INPUT);
    expect(result.error.message).toBe('Input must start with /zai');
    expect(isValid(result)).toBe(false);
  });

  test('returns malformed_input error for /zai with no command', () => {
    const result = parseCommand('/zai');
    expect(result.error.type).toBe(ERROR_TYPES.MALFORMED_INPUT);
    expect(result.error.message).toBe('Missing command after /zai');
    expect(isValid(result)).toBe(false);
  });

  test('returns unknown_command error for invalid command', () => {
    const result = parseCommand('/zai execute something');
    expect(result.error.type).toBe(ERROR_TYPES.UNKNOWN_COMMAND);
    expect(result.error.message).toBe('Unknown command: execute');
    expect(isValid(result)).toBe(false);
  });

  test('handles command case-insensitively', () => {
    const result = parseCommand('/ZAI ASK question');
    expect(result.command).toBe('ask');
    expect(result.error).toBe(null);
  });

  test('preserves raw input in result', () => {
    const input = '/zai ask my question';
    const result = parseCommand(input);
    expect(result.raw).toBe(input);
  });
});

describe('normalizeInput', () => {
  test('normalizes @zai-bot mention to /zai', () => {
    expect(normalizeInput('@zai-bot ask question')).toBe('/zai ask question');
  });

  test('normalizes @zai-bot with hyphen', () => {
    expect(normalizeInput('@zai-bot ask question')).toBe('/zai ask question');
  });

  test('normalizes @zaibot (no hyphen)', () => {
    expect(normalizeInput('@zaibot ask question')).toBe('/zai ask question');
  });

  test('normalizes @zai (no bot suffix)', () => {
    expect(normalizeInput('@zai ask question')).toBe('/zai ask question');
  });

  test('normalizes @ZAI-BOT (uppercase)', () => {
    expect(normalizeInput('@ZAI-BOT ask question')).toBe('/zai ask question');
  });

  test('preserves /zai input unchanged', () => {
    expect(normalizeInput('/zai ask question')).toBe('/zai ask question');
  });

  test('handles non-string input', () => {
    expect(normalizeInput(null)).toBe('');
    expect(normalizeInput(undefined)).toBe('');
  });

  test('trims whitespace', () => {
    expect(normalizeInput('  /zai ask  ')).toBe('/zai ask');
  });
});

describe('mention normalization in parseCommand', () => {
  test('parses @zai-bot mention as /zai command', () => {
    const result = parseCommand('@zai-bot ask what is this?');
    expect(result.command).toBe('ask');
    expect(result.error).toBe(null);
  });

  test('parses @zaibot mention as /zai command', () => {
    const result = parseCommand('@zaibot review file.ts');
    expect(result.command).toBe('review');
    expect(result.error).toBe(null);
  });

  test('parses @ZAI-BOT uppercase mention', () => {
    const result = parseCommand('@ZAI-BOT describe');
    expect(result.command).toBe('describe');
    expect(result.error).toBe(null);
  });
});

describe('ALLOWED_COMMANDS', () => {
  test('contains all expected commands', () => {
    assert(ALLOWED_COMMANDS.includes('ask'));
    assert(ALLOWED_COMMANDS.includes('review'));
    assert(ALLOWED_COMMANDS.includes('explain'));
    assert(ALLOWED_COMMANDS.includes('help'));
    assert(ALLOWED_COMMANDS.includes('describe'));
    assert(ALLOWED_COMMANDS.includes('impact'));
  });

  test('does not contain removed commands', () => {
    assert(!ALLOWED_COMMANDS.includes('suggest'));
    assert(!ALLOWED_COMMANDS.includes('compare'));
  });
});

describe('ERROR_TYPES', () => {
  test('has all expected error types', () => {
    expect(ERROR_TYPES.UNKNOWN_COMMAND).toBe('unknown_command');
    expect(ERROR_TYPES.MALFORMED_INPUT).toBe('malformed_input');
    expect(ERROR_TYPES.EMPTY_INPUT).toBe('empty_input');
  });
});
