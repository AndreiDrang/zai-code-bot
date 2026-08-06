/**
 * Z.ai Code Bot (hybrid Workers) — unit tests.
 * Plain Node runner: `node tests/test.js`
 *
 * Covers the shared pure modules (commands, crypto, logging) plus the main
 * worker's router classification. No live API calls are made.
 */

import { parseCommand, isCommand, getAvailableCommands, formatHelp } from '../shared/commands.js';
import { GitHubClient } from '../shared/github.js';
import { hmacSha256Hex, timingSafeEqualStr } from '../shared/crypto.js';
import { createLogger } from '../shared/logging.js';
import { classifyCommand, getAllCommands } from '../zai-main-worker/src/router.js';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

// --- Command parsing -------------------------------------------------------
function testCommandParsing() {
  console.log('📝 Command parsing');
  const cases = [
    { input: '/zai help', expect: { type: 'help', isValid: true } },
    { input: '/zai-bot help', expect: { type: 'help', isValid: true } },
    { input: '@zai-bot help', expect: { type: 'help', isValid: true } },
    { input: '/zai review', expect: { type: 'review', isValid: true } },
    { input: '/zai impact', expect: { type: 'impact', isValid: true } },
    { input: '/zai describe', expect: { type: 'describe', isValid: true } },
    { input: '/zai unknown', expect: { type: 'unknown', isValid: false } },
    { input: 'random text', expect: null },
    { input: '', expect: null },
    { input: null, expect: null },
    {
      input: '/zai explain 10-20',
      expect: { type: 'explain', args: '10-20', isValid: true },
    },
    {
      input: '/zai ask what does this fn do?',
      expect: { type: 'ask', args: 'what does this fn do?', isValid: true },
    },
  ];
  for (const c of cases) {
    const r = parseCommand(c.input);
    const ok =
      (r === null && c.expect === null) ||
      (r &&
        r.type === c.expect.type &&
        r.isValid === c.expect.isValid &&
        (c.expect.args === undefined || r.args === c.expect.args));
    assert(ok, c.input || '(empty)');
  }
  console.log();
}

// --- isCommand -------------------------------------------------------------
function testIsCommand() {
  console.log('📝 isCommand');
  assert(isCommand('/zai help') === true, '/zai help → true');
  assert(isCommand('@zai-bot review') === true, '@zai-bot review → true');
  assert(isCommand('random text') === false, 'random text → false');
  assert(isCommand('') === false, 'empty → false');
  assert(isCommand(null) === false, 'null → false');
  console.log();
}

// --- allowlist -------------------------------------------------------------
function testAllowlist() {
  console.log('📝 command allowlist');
  const cmds = getAvailableCommands();
  assert(
    ['help', 'ask', 'review', 'explain', 'describe', 'impact'].every((c) => cmds.includes(c)),
    'all six commands present',
  );
  console.log();
}

// --- formatHelp ------------------------------------------------------------
function testFormatHelp() {
  console.log('📝 formatHelp');
  const help = formatHelp();
  assert(help.includes('/zai help'), 'contains /zai help');
  assert(help.includes('/zai review'), 'contains /zai review');
  assert(help.includes('<!-- zai-code-review -->'), 'contains comment marker');
  console.log();
}

// --- GitHubClient ----------------------------------------------------------
function testGitHubClient() {
  console.log('📝 GitHubClient');
  const client = new GitHubClient('mock-token');
  assert(client && client.token === 'mock-token', 'instantiates + stores token');
  assert(client.baseUrl === 'https://api.github.com', 'correct API base');
  console.log();
}

// --- Web Crypto (webhook signature) ---------------------------------------
function testCrypto() {
  console.log('📝 shared/crypto (Web Crypto)');
  const hex = hmacSha256Hex('secret', 'payload');
  // Known fixture: HMAC-SHA256("secret","payload")
  hex.then((d) => {
    assert(
      d === 'b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4',
      'HMAC-SHA256 matches known fixture',
    );
    assert(timingSafeEqualStr(d, d) === true, 'timingSafeEqualStr equal → true');
    assert(
      timingSafeEqualStr(d, d.slice(0, -1)) === false,
      'timingSafeEqualStr diff-length → false',
    );
    assert(timingSafeEqualStr('abc', 'abd') === false, 'timingSafeEqualStr diff → false');
    console.log();
    testRouter();
    testLogger();
    finish();
  });
}

// --- Router classification -------------------------------------------------
function testRouter() {
  console.log('📝 router classification');
  assert(classifyCommand('help') === 'light', 'help → light');
  assert(classifyCommand('describe') === 'light', 'describe → light');
  assert(classifyCommand('ask') === 'light', 'ask → light');
  assert(classifyCommand('explain') === 'light', 'explain → light');
  assert(classifyCommand('review') === 'heavy', 'review → heavy');
  assert(classifyCommand('impact') === 'heavy', 'impact → heavy');
  assert(classifyCommand('bogus') === 'unsupported', 'unknown → unsupported');
  assert(getAllCommands().length >= 6, 'getAllCommands returns full set');
  console.log();
}

// --- Logger (regression: this-binding bug) --------------------------------
function testLogger() {
  console.log('📝 logging (this-binding regression)');
  let ok = true;
  try {
    const log = createLogger({ NODE_ENV: 'development' }, 'test');
    log.info('info works');
    log.warn('warn works');
    log.error('error works');
    log.debug('debug works');
  } catch {
    ok = false;
  }
  assert(ok, 'all log methods callable without throwing (POC bug fixed)');
  console.log();
}

function finish() {
  console.log('='.repeat(60));
  console.log(`Test Summary: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}

console.log('='.repeat(60));
console.log('Z.ai Code Bot (hybrid Workers) — Test Suite');
console.log('='.repeat(60));
console.log();
testCommandParsing();
testIsCommand();
testAllowlist();
testFormatHelp();
testGitHubClient();
testCrypto();
