const { test, describe } = require('node:test');
const assert = require('node:assert');
const askHandler = require('../src/lib/handlers/ask.js');
const helpHandler = require('../src/lib/handlers/help.js');
const handlers = require('../src/lib/handlers/index.js');

describe('ask handler', () => {
  test('validateArgs returns error for empty args', () => {
    const result = askHandler.validateArgs([]);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Please provide a question'));
  });

  test('validateArgs returns error for whitespace-only args', () => {
    const result = askHandler.validateArgs(['   ', '']);
    assert.strictEqual(result.valid, false);
    assert.ok(result.error.includes('Please provide a question'));
  });

  test('validateArgs returns valid for non-empty args', () => {
    const result = askHandler.validateArgs(['what', 'is', 'this']);
    assert.strictEqual(result.valid, true);
  });

  test('buildPrompt builds correct prompt', () => {
    const prompt = askHandler.buildPrompt('What is this?', 'PR context here');
    assert.ok(prompt.includes('What is this?'));
    assert.ok(prompt.includes('PR context here'));
    assert.ok(prompt.includes('Question:'));
  });

  test('formatResponse formats correctly', () => {
    const response = askHandler.formatResponse('This is the answer.', 'What is this?');
    assert.ok(response.includes('This is the answer.'));
    assert.ok(response.includes('What is this?'));
    assert.ok(response.includes('Answer to:'));
  });
});

describe('help handler', () => {
  test('HELP_TEXT contains all commands', () => {
    assert.ok(helpHandler.HELP_TEXT.includes('/zai ask'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai review'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai explain'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai suggest'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai compare'));
    assert.ok(helpHandler.HELP_TEXT.includes('/zai help'));
  });

  test('HELP_MARKER is defined', () => {
    assert.strictEqual(typeof helpHandler.HELP_MARKER, 'string');
    assert.ok(helpHandler.HELP_MARKER.length > 0);
  });
});

describe('handler registry', () => {
  test('getHandler returns ask handler', () => {
    const handler = handlers.getHandler('ask');
    assert.strictEqual(typeof handler, 'function');
  });

  test('getHandler returns help handler', () => {
    const handler = handlers.getHandler('help');
    assert.strictEqual(typeof handler, 'function');
  });

  test('getHandler returns null for unknown command', () => {
    const handler = handlers.getHandler('unknown');
    assert.strictEqual(handler, null);
  });

  test('hasHandler returns true for known commands', () => {
    assert.strictEqual(handlers.hasHandler('ask'), true);
    assert.strictEqual(handlers.hasHandler('help'), true);
  });

  test('hasHandler returns false for unknown commands', () => {
    assert.strictEqual(handlers.hasHandler('unknown'), false);
  });

  test('getAllCommands returns all commands', () => {
    const commands = handlers.getAllCommands();
    assert.ok(commands.includes('ask'));
    assert.ok(commands.includes('help'));
  });
});
