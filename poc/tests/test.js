/**
 * Tests for Z.ai Code Bot POC
 */

import { parseCommand, isCommand, getAvailableCommands, formatHelp } from '../src/lib/commands.js';
import { GitHubClient } from '../src/lib/github.js';

console.log('🧪 Running POC tests...\n');

// Test 1: Command parsing
function testCommandParsing() {
  console.log('📝 Test 1: Command parsing');
  
  const testCases = [
    {
      input: '/zai help',
      expected: { type: 'help', isValid: true },
      description: 'Basic /zai help command'
    },
    {
      input: '/zai-bot help',
      expected: { type: 'help', isValid: true },
      description: '/zai-bot help command'
    },
    {
      input: '@zai-bot help',
      expected: { type: 'help', isValid: true },
      description: '@zai-bot help command'
    },
    {
      input: '/zai review',
      expected: { type: 'review', isValid: true },
      description: 'Valid review command'
    },
    {
      input: '/zai unknown',
      expected: { type: 'unknown', isValid: false },
      description: 'Unknown command'
    },
    {
      input: 'random text',
      expected: null,
      description: 'Non-command text'
    },
    {
      input: '',
      expected: null,
      description: 'Empty string'
    },
    {
      input: null,
      expected: null,
      description: 'Null input'
    },
    {
      input: '/zai explain 10-20',
      expected: { type: 'explain', args: '10-20', isValid: true },
      description: 'Command with arguments'
    },
    {
      input: '/zai ask what does this function do?',
      expected: { type: 'ask', args: 'what does this function do?', isValid: true },
      description: 'Command with question'
    }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testCases) {
    const result = parseCommand(testCase.input);
    
    const typeMatch = result?.type === testCase.expected?.type;
    const validMatch = result?.isValid === testCase.expected?.isValid;
    const argsMatch = result?.args === testCase.expected?.args;
    const isNullMatch = result === null && testCase.expected === null;
    
    const success = (typeMatch && validMatch && argsMatch) || isNullMatch;
    
    if (success) {
      console.log(`  ✅ ${testCase.description}`);
      passed++;
    } else {
      console.log(`  ❌ ${testCase.description}`);
      console.log(`     Expected: ${JSON.stringify(testCase.expected)}`);
      console.log(`     Got:      ${JSON.stringify(result)}`);
      failed++;
    }
  }
  
  console.log(`  Results: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// Test 2: isCommand function
function testIsCommand() {
  console.log('📝 Test 2: isCommand function');
  
  const testCases = [
    { input: '/zai help', expected: true },
    { input: '@zai-bot review', expected: true },
    { input: 'random text', expected: false },
    { input: '', expected: false },
    { input: null, expected: false }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const testCase of testCases) {
    const result = isCommand(testCase.input);
    const success = result === testCase.expected;
    
    if (success) {
      console.log(`  ✅ isCommand("${testCase.input}") = ${result}`);
      passed++;
    } else {
      console.log(`  ❌ isCommand("${testCase.input}") = ${result}, expected ${testCase.expected}`);
      failed++;
    }
  }
  
  console.log(`  Results: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// Test 3: getAvailableCommands
function testGetAvailableCommands() {
  console.log('📝 Test 3: getAvailableCommands');
  
  const commands = getAvailableCommands();
  const expectedCommands = ['help', 'ask', 'review', 'explain', 'describe', 'impact'];
  
  const hasAllCommands = expectedCommands.every(cmd => commands.includes(cmd));
  const hasOnlyExpected = commands.every(cmd => expectedCommands.includes(cmd));
  
  if (hasAllCommands && hasOnlyExpected) {
    console.log(`  ✅ All expected commands present: ${commands.join(', ')}`);
    console.log(`  Results: 1 passed, 0 failed\n`);
    return true;
  } else {
    console.log(`  ❌ Command list mismatch`);
    console.log(`     Expected: ${expectedCommands.join(', ')}`);
    console.log(`     Got:      ${commands.join(', ')}`);
    console.log(`  Results: 0 passed, 1 failed\n`);
    return false;
  }
}

// Test 4: formatHelp
function testFormatHelp() {
  console.log('📝 Test 4: formatHelp');
  
  const help = formatHelp();
  
  const checks = [
    { check: help.length > 100, description: 'Help message has reasonable length' },
    { check: help.includes('/zai help'), description: 'Contains /zai help' },
    { check: help.includes('/zai review'), description: 'Contains /zai review' },
    { check: help.includes('Z.ai'), description: 'Contains Z.ai reference' },
    { check: help.includes('Cloudflare'), description: 'Contains Cloudflare reference' },
    { check: help.includes('<!-- zai-code-review -->'), description: 'Contains comment marker' }
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const check of checks) {
    if (check.check) {
      console.log(`  ✅ ${check.description}`);
      passed++;
    } else {
      console.log(`  ❌ ${check.description}`);
      failed++;
    }
  }
  
  console.log(`  Help message length: ${help.length} characters`);
  console.log(`  Results: ${passed} passed, ${failed} failed\n`);
  return failed === 0;
}

// Test 5: GitHubClient (mock test)
function testGitHubClient() {
  console.log('📝 Test 5: GitHubClient instantiation');
  
  try {
    const mockToken = 'mock-github-token';
    const client = new GitHubClient(mockToken);
    
    if (client && client.token === mockToken) {
      console.log(`  ✅ GitHubClient instantiated correctly`);
      console.log(`  ✅ Token stored correctly`);
      console.log(`  Results: 2 passed, 0 failed\n`);
      return true;
    } else {
      console.log(`  ❌ GitHubClient instantiation failed`);
      console.log(`  Results: 0 passed, 1 failed\n`);
      return false;
    }
  } catch (error) {
    console.log(`  ❌ GitHubClient test failed: ${error.message}`);
    console.log(`  Results: 0 passed, 1 failed\n`);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  console.log('='.repeat(60));
  console.log('Z.ai Code Bot POC - Test Suite');
  console.log('='.repeat(60) + '\n');
  
  const results = [];
  
  results.push(await testCommandParsing());
  results.push(testIsCommand());
  results.push(testGetAvailableCommands());
  results.push(testFormatHelp());
  results.push(testGitHubClient());
  
  const totalPassed = results.filter(r => r).length;
  const totalTests = results.length;
  
  console.log('='.repeat(60));
  console.log(`Test Summary: ${totalPassed}/${totalTests} tests passed`);
  console.log('='.repeat(60));
  
  if (totalPassed === totalTests) {
    console.log('🎉 All tests passed!');
    process.exit(0);
  } else {
    console.log('❌ Some tests failed!');
    process.exit(1);
  }
}

// Run tests
runAllTests().catch(error => {
  console.error('Test execution failed:', error);
  process.exit(1);
});
