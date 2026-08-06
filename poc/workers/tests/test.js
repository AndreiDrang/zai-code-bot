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
import { resolveSecretValue } from '../shared/secrets.js';
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
    { input: '/zai-bot help', expect: null }, // slash-bot form no longer accepted
    { input: '@zai-bot help', expect: null }, // mention form no longer accepted
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
  assert(isCommand('@zai-bot review') === false, '@zai-bot review → false (mention removed)');
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
  assert(
    help.includes('[AndreiDrang](https://github.com/AndreiDrang)'),
    'footer credits AndreiDrang with GitHub link',
  );
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

// --- GitHubClient (204 empty-body regression) -----------------------------
async function testGitHubClientEmptyBody() {
  console.log('📝 GitHubClient (204 empty-body regression)');
  const originalFetch = globalThis.fetch;
  const client = new GitHubClient('tok');
  try {
    // 204 No Content — body is empty; must return null, NOT throw
    // "Unexpected end of JSON input".
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert(
      (await client.request('GET', '/repos/o/r/collaborators/u')) === null,
      '204 No Content → null (no JSON parse error)',
    );
    // 200 with a JSON body still parses.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    assert((await client.request('GET', '/x')).ok === true, '200 JSON body parses');
    // returnText still returns the raw body.
    globalThis.fetch = async () => new Response('raw', { status: 200 });
    assert(
      (await client.request('GET', '/x', null, { returnText: true })) === 'raw',
      'returnText returns raw body',
    );
    // non-ok throws with error.status set (callers depend on this).
    globalThis.fetch = async () => new Response('nope', { status: 404 });
    let threw = false;
    try {
      await client.request('GET', '/x');
    } catch (e) {
      threw = true;
      assert(e.status === 404, '404 throws with error.status');
    }
    assert(threw, 'non-ok response throws');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log();
}

// --- Web Crypto (webhook signature) ---------------------------------------
function testCrypto() {
  console.log('📝 shared/crypto (Web Crypto)');
  const hex = hmacSha256Hex('secret', 'payload');
  // Known fixture: HMAC-SHA256("secret","payload")
  hex.then(async (d) => {
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
    await testSecrets();
    await testGitHubClientEmptyBody();
    testRouter();
    testLogger();
    finish();
  });
}

// --- Secrets Store binding resolver --------------------------------------
async function testSecrets() {
  console.log('📝 shared/secrets (Secrets Store binding resolver)');
  assert((await resolveSecretValue('hunter2')) === 'hunter2', 'plain string → string');
  assert((await resolveSecretValue('  hunter2 ')) === 'hunter2', 'trims whitespace');
  assert((await resolveSecretValue('')) === undefined, 'empty string → undefined');
  assert((await resolveSecretValue('   ')) === undefined, 'whitespace-only → undefined');
  assert((await resolveSecretValue(undefined)) === undefined, 'undefined → undefined');
  assert((await resolveSecretValue(null)) === undefined, 'null → undefined');
  assert((await resolveSecretValue(123)) === undefined, 'number → undefined');
  assert((await resolveSecretValue({})) === undefined, 'plain object → undefined');
  assert(
    (await resolveSecretValue({ get: async () => 'tok-from-get' })) === 'tok-from-get',
    '{get(): Promise<string>} → string',
  );
  assert(
    (await resolveSecretValue({ get: async () => '' })) === undefined,
    '{get()} empty → undefined',
  );
  assert(
    (await resolveSecretValue(Promise.resolve('tok-from-promise'))) === 'tok-from-promise',
    'Promise<string> → string',
  );
  assert(
    (await resolveSecretValue(Promise.resolve(''))) === undefined,
    'Promise empty → undefined',
  );
  console.log();
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
