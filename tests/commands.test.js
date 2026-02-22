const { test, describe } = require('node:test');
const assert = require('node:assert');
const { parseCommand, normalizeInput, isValid, ALLOWED_COMMANDS, ERROR_TYPES } = require('../src/lib/commands.js');

describe('parseCommand', () => {
  test('parses valid /zai ask command', () => {
    const result = parseCommand('/zai ask what is this function doing?');
    assert.strictEqual(result.command, 'ask');
    assert.deepStrictEqual(result.args, ['what', 'is', 'this', 'function', 'doing?']);
    assert.strictEqual(result.raw, '/zai ask what is this function doing?');
    assert.strictEqual(result.error, null);
    assert.strictEqual(isValid(result), true);
  });

  test('parses valid /zai review command', () => {
    const result = parseCommand('/zai review src/utils.ts');
    assert.strictEqual(result.command, 'review');
    assert.deepStrictEqual(result.args, ['src/utils.ts']);
    assert.strictEqual(result.error, null);
  });

  test('parses valid /zai explain command', () => {
    const result = parseCommand('/zai explain 10-15');
    assert.strictEqual(result.command, 'explain');
    assert.deepStrictEqual(result.args, ['10-15']);
    assert.strictEqual(result.error, null);
  });

  test('parses valid /zai suggest command', () => {
    const result = parseCommand('/zai suggest better naming');
    assert.strictEqual(result.command, 'suggest');
    assert.deepStrictEqual(result.args, ['better', 'naming']);
    assert.strictEqual(result.error, null);
  });

  test('parses valid /zai compare command', () => {
    const result = parseCommand('/zai compare');
    assert.strictEqual(result.command, 'compare');
    assert.deepStrictEqual(result.args, []);
    assert.strictEqual(result.error, null);
  });

  test('parses valid /zai help command', () => {
    const result = parseCommand('/zai help');
    assert.strictEqual(result.command, 'help');
    assert.deepStrictEqual(result.args, []);
    assert.strictEqual(result.error, null);
  });

  test('returns empty_input error for null input', () => {
    const result = parseCommand(null);
    assert.strictEqual(result.command, null);
    assert.deepStrictEqual(result.args, []);
    assert.strictEqual(result.error.type, ERROR_TYPES.EMPTY_INPUT);
    assert.strictEqual(isValid(result), false);
  });

  test('returns empty_input error for undefined input', () => {
    const result = parseCommand(undefined);
    assert.strictEqual(result.error.type, ERROR_TYPES.EMPTY_INPUT);
    assert.strictEqual(isValid(result), false);
  });

  test('returns empty_input error for empty string', () => {
    const result = parseCommand('');
    assert.strictEqual(result.error.type, ERROR_TYPES.EMPTY_INPUT);
    assert.strictEqual(isValid(result), false);
  });

  test('returns empty_input error for whitespace-only string', () => {
    const result = parseCommand('   ');
    assert.strictEqual(result.error.type, ERROR_TYPES.EMPTY_INPUT);
    assert.strictEqual(isValid(result), false);
  });

  test('returns malformed_input error for input without /zai', () => {
    const result = parseCommand('hello world');
    assert.strictEqual(result.error.type, ERROR_TYPES.MALFORMED_INPUT);
    assert.strictEqual(result.error.message, 'Input must start with /zai');
    assert.strictEqual(isValid(result), false);
  });

  test('returns malformed_input error for /zai with no command', () => {
    const result = parseCommand('/zai');
    assert.strictEqual(result.error.type, ERROR_TYPES.MALFORMED_INPUT);
    assert.strictEqual(result.error.message, 'Missing command after /zai');
    assert.strictEqual(isValid(result), false);
  });

  test('returns unknown_command error for invalid command', () => {
    const result = parseCommand('/zai execute something');
    assert.strictEqual(result.error.type, ERROR_TYPES.UNKNOWN_COMMAND);
    assert.strictEqual(result.error.message, 'Unknown command: execute');
    assert.strictEqual(isValid(result), false);
  });

  test('handles command case-insensitively', () => {
    const result = parseCommand('/ZAI ASK question');
    assert.strictEqual(result.command, 'ask');
    assert.strictEqual(result.error, null);
  });

  test('preserves raw input in result', () => {
    const input = '/zai ask my question';
    const result = parseCommand(input);
    assert.strictEqual(result.raw, input);
  });
});

describe('normalizeInput', () => {
  test('normalizes @zai-bot mention to /zai', () => {
    assert.strictEqual(normalizeInput('@zai-bot ask question'), '/zai ask question');
  });

  test('normalizes @zai-bot with hyphen', () => {
    assert.strictEqual(normalizeInput('@zai-bot ask question'), '/zai ask question');
  });

  test('normalizes @zaibot (no hyphen)', () => {
    assert.strictEqual(normalizeInput('@zaibot ask question'), '/zai ask question');
  });

  test('normalizes @zai (no bot suffix)', () => {
    assert.strictEqual(normalizeInput('@zai ask question'), '/zai ask question');
  });

  test('normalizes @ZAI-BOT (uppercase)', () => {
    assert.strictEqual(normalizeInput('@ZAI-BOT ask question'), '/zai ask question');
  });

  test('preserves /zai input unchanged', () => {
    assert.strictEqual(normalizeInput('/zai ask question'), '/zai ask question');
  });

  test('handles non-string input', () => {
    assert.strictEqual(normalizeInput(null), '');
    assert.strictEqual(normalizeInput(undefined), '');
  });

  test('trims whitespace', () => {
    assert.strictEqual(normalizeInput('  /zai ask  '), '/zai ask');
  });
});

describe('mention normalization in parseCommand', () => {
  test('parses @zai-bot mention as /zai command', () => {
    const result = parseCommand('@zai-bot ask what is this?');
    assert.strictEqual(result.command, 'ask');
    assert.strictEqual(result.error, null);
  });

  test('parses @zaibot mention as /zai command', () => {
    const result = parseCommand('@zaibot review file.ts');
    assert.strictEqual(result.command, 'review');
    assert.strictEqual(result.error, null);
  });

  test('parses @ZAI-BOT uppercase mention', () => {
    const result = parseCommand('@ZAI-BOT suggest improvement');
    assert.strictEqual(result.command, 'suggest');
    assert.strictEqual(result.error, null);
  });
});

describe('ALLOWED_COMMANDS', () => {
  test('contains all expected commands', () => {
    assert(ALLOWED_COMMANDS.includes('ask'));
    assert(ALLOWED_COMMANDS.includes('review'));
    assert(ALLOWED_COMMANDS.includes('explain'));
    assert(ALLOWED_COMMANDS.includes('suggest'));
    assert(ALLOWED_COMMANDS.includes('compare'));
    assert(ALLOWED_COMMANDS.includes('help'));
  });
});

describe('ERROR_TYPES', () => {
  test('has all expected error types', () => {
    assert.strictEqual(ERROR_TYPES.UNKNOWN_COMMAND, 'unknown_command');
    assert.strictEqual(ERROR_TYPES.MALFORMED_INPUT, 'malformed_input');
    assert.strictEqual(ERROR_TYPES.EMPTY_INPUT, 'empty_input');
  });
});
