const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  createMockOctokit,
  createMockApiClient,
  createMockContext,
  createMockCore,
} = require('./helpers/mocks');

describe('Fixtures', () => {
  test('pr-event.json is valid JSON', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'pr-event.json');
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const payload = JSON.parse(content);

    assert.ok(payload.pull_request, 'payload should have pull_request');
    assert.ok(payload.repository, 'payload should have repository');
    assert.strictEqual(payload.pull_request.number, 42);
    assert.strictEqual(payload.repository.name, 'Hello-World');
  });

  test('issue-comment-event.json is valid JSON', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'issue-comment-event.json');
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const payload = JSON.parse(content);

    assert.ok(payload.issue, 'payload should have issue');
    assert.ok(payload.comment, 'payload should have comment');
    assert.ok(payload.repository, 'payload should have repository');
    assert.strictEqual(payload.issue.number, 42);
    assert.ok(payload.issue.pull_request, 'issue should have pull_request field');
  });

  test('pr-event fixture has required fields for action', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'pr-event.json');
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const payload = JSON.parse(content);

    assert.ok(payload.pull_request.number, 'PR number is required');
    assert.ok(payload.repository.owner, 'repository owner is required');
    assert.ok(payload.repository.name, 'repository name is required');
  });
});

describe('Mocks', () => {
  test('createMockOctokit returns object with rest API', () => {
    const mockOctokit = createMockOctokit();

    assert.ok(mockOctokit.rest, 'should have rest property');
    assert.ok(typeof mockOctokit.rest.pulls.listFiles, 'should have listFiles');
    assert.ok(typeof mockOctokit.rest.issues.listComments, 'should have listComments');
  });

  test('createMockOctokit accepts custom files', async () => {
    const mockFiles = [
      { filename: 'test.js', status: 'modified', patch: '...' },
    ];
    const mockOctokit = createMockOctokit({ files: mockFiles });

    const result = await mockOctokit.rest.pulls.listFiles({
      owner: 'test',
      repo: 'test',
      pull_number: 1,
    });

    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].filename, 'test.js');
  });

  test('createMockOctokit accepts custom comments', async () => {
    const mockComments = [
      { id: 1, body: 'Test comment' },
    ];
    const mockOctokit = createMockOctokit({ comments: mockComments });

    const result = await mockOctokit.rest.issues.listComments({
      owner: 'test',
      repo: 'test',
      issue_number: 1,
    });

    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].body, 'Test comment');
  });

  test('createMockApiClient returns function', () => {
    const mockClient = createMockApiClient();

    assert.strictEqual(typeof mockClient, 'function');
  });

  test('createMockApiClient returns response', async () => {
    const mockClient = createMockApiClient({ response: 'Test response' });

    const result = await mockClient('apiKey', 'model', 'prompt');

    assert.strictEqual(result, 'Test response');
  });

  test('createMockApiClient throws error when configured', async () => {
    const mockError = new Error('API Error');
    const mockClient = createMockApiClient({ response: mockError });

    await assert.rejects(
      async () => await mockClient('apiKey', 'model', 'prompt'),
      { message: 'API Error' }
    );
  });

  test('createMockContext extracts repo info', () => {
    const payload = {
      repository: {
        owner: { login: 'test-owner' },
        name: 'test-repo',
      },
    };
    const ctx = createMockContext(payload);

    assert.strictEqual(ctx.repo.owner, 'test-owner');
    assert.strictEqual(ctx.repo.repo, 'test-repo');
  });

  test('createMockCore getInput returns input value', () => {
    const core = createMockCore();
    core.setInput('test_input', 'test_value');

    const result = core.getInput('test_input');

    assert.strictEqual(result, 'test_value');
  });

  test('createMockCore getInput throws for required missing input', () => {
    const core = createMockCore();

    assert.throws(
      () => core.getInput('missing', { required: true }),
      { message: 'Input required and not provided: missing' }
    );
  });

  test('createMockCore setFailed stores message', () => {
    const core = createMockCore();
    core.setFailed('Test failure');

    const failedMsg = core.messages.find(m => m.level === 'failed');
    assert.strictEqual(failedMsg.message, 'Test failure');
  });
});
