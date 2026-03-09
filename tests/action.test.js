import { test, describe, expect } from 'vitest';
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

    expect(payload.pull_request, 'payload should have pull_request').toBeTruthy();
    expect(payload.repository, 'payload should have repository').toBeTruthy();
    expect(payload.pull_request.number).toBe(42);
    expect(payload.repository.name).toBe('Hello-World');
  });

  test('issue-comment-event.json is valid JSON', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'issue-comment-event.json');
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const payload = JSON.parse(content);

    expect(payload.issue, 'payload should have issue').toBeTruthy();
    expect(payload.comment, 'payload should have comment').toBeTruthy();
    expect(payload.repository, 'payload should have repository').toBeTruthy();
    expect(payload.issue.number).toBe(42);
    expect(payload.issue.pull_request, 'issue should have pull_request field').toBeTruthy();
  });

  test('pr-event fixture has required fields for action', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'pr-event.json');
    const content = fs.readFileSync(fixturePath, 'utf-8');
    const payload = JSON.parse(content);

    expect(payload.pull_request.number, 'PR number is required').toBeTruthy();
    expect(payload.repository.owner, 'repository owner is required').toBeTruthy();
    expect(payload.repository.name, 'repository name is required').toBeTruthy();
  });
});

describe('Mocks', () => {
  test('createMockOctokit returns object with rest API', () => {
    const mockOctokit = createMockOctokit();

    expect(mockOctokit.rest, 'should have rest property').toBeTruthy();
    expect(typeof mockOctokit.rest.pulls.listFiles, 'should have listFiles').toBeTruthy();
    expect(typeof mockOctokit.rest.issues.listComments, 'should have listComments').toBeTruthy();
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

    expect(result.data.length).toBe(1);
    expect(result.data[0].filename).toBe('test.js');
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

    expect(result.data.length).toBe(1);
    expect(result.data[0].body).toBe('Test comment');
  });

  test('createMockApiClient returns function', () => {
    const mockClient = createMockApiClient();

    expect(typeof mockClient).toBe('function');
  });

  test('createMockApiClient returns response', async () => {
    const mockClient = createMockApiClient({ response: 'Test response' });

    const result = await mockClient('apiKey', 'model', 'prompt');

    expect(result).toBe('Test response');
  });

  test('createMockApiClient throws error when configured', async () => {
    const mockError = new Error('API Error');
    const mockClient = createMockApiClient({ response: mockError });

    await await expect(
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

    expect(ctx.repo.owner).toBe('test-owner');
    expect(ctx.repo.repo).toBe('test-repo');
  });

  test('createMockCore getInput returns input value', () => {
    const core = createMockCore();
    core.setInput('test_input', 'test_value');

    const result = core.getInput('test_input');

    expect(result).toBe('test_value');
  });

  test('createMockCore getInput throws for required missing input', () => {
    const core = createMockCore();

    expect(() => 
      () => core.getInput('missing', { required: true }),
      { message: 'Input required and not provided: missing' }
    );
  });

  test('createMockCore setFailed stores message', () => {
    const core = createMockCore();
    core.setFailed('Test failure');

    const failedMsg = core.messages.find(m => m.level === 'failed');
    expect(failedMsg.message).toBe('Test failure');
  });
});
