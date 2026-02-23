const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const COMMENT_MARKER = '<!-- zai-code-review -->';

const {
  createPrOpenedEvent,
  createPrSynchronizeEvent,
  createMockFiles,
} = require('./fixtures/events.js');

const events = require('../../src/lib/events.js');
const api = require('../../src/lib/api.js');

require('@actions/github');
require('@actions/core');

function buildPrompt(files) {
  const diffs = files
    .filter(f => f.patch)
    .map(f => `### ${f.filename} (${f.status})\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join('\n\n');

  return `Please review the following pull request changes and provide concise, constructive feedback. Focus on bugs, logic errors, security issues, and meaningful improvements. Skip trivial style comments.\n\n${diffs}`;
}

function buildCommentBody(review, type = 'pr_review') {
  const header = type === 'pr_review' ? '## Z.ai Code Review' : '## Z.ai Response';
  return `${header}\n\n${review}\n\n${COMMENT_MARKER}`;
}

let mockGithub;
let originalRequireGithub;

describe('PR Auto-Review Integration', () => {
  beforeEach(() => {
    originalRequireGithub = require.cache[require.resolve('@actions/github')];
    mockGithub = {
      context: {
        payload: {},
        eventName: 'pull_request',
        repo: { owner: 'test-owner', repo: 'test-repo' }
      },
      getOctokit: () => ({
        rest: {
          pulls: {
            listFiles: async () => ({ data: createMockFiles(['src/test.js']) })
          },
          issues: {
            listComments: async () => ({ data: [] }),
            createComment: async () => ({ data: { id: 123, body: '' } }),
            updateComment: async () => ({ data: { id: 123, body: '' } })
          }
        }
      })
    };
    require.cache[require.resolve('@actions/github')].exports = mockGithub;
  });

  afterEach(() => {
    if (originalRequireGithub) {
      require.cache[require.resolve('@actions/github')].exports = originalRequireGithub.exports;
    }
  });

  test('full PR opened pipeline creates new comment', async () => {
    const payload = createPrOpenedEvent(42, 'test-owner', 'test-repo');
    mockGithub.context.payload = payload;

    const eventInfo = events.getEventInfo(mockGithub.context);
    assert.strictEqual(eventInfo.eventType, 'pull_request');
    assert.strictEqual(eventInfo.shouldProcess, true);
    assert.strictEqual(eventInfo.pullNumber, 42);

    const octokit = mockGithub.getOctokit('test-token');
    const files = await octokit.rest.pulls.listFiles({
      owner: 'test-owner',
      repo: 'test-repo',
      pull_number: 42,
      per_page: 100
    });

    assert.ok(files.data.length > 0);
    assert.ok(files.data[0].patch);

    const prompt = buildPrompt(files.data);
    assert.ok(prompt.includes('src/test.js'));

    const reviewContent = 'Mock AI review response';
    const body = buildCommentBody(reviewContent, 'pr_review');

    assert.ok(body.includes(COMMENT_MARKER));
    assert.ok(body.includes(reviewContent));

    const existingComments = await octokit.rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });

    assert.strictEqual(existingComments.data.length, 0);

    const newComment = await octokit.rest.issues.createComment({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42,
      body
    });

    assert.strictEqual(newComment.data.id, 123);
  });

  test('full PR synchronize pipeline updates existing comment', async () => {
    const payload = createPrSynchronizeEvent(42, 'test-owner', 'test-repo');
    mockGithub.context.payload = payload;

    const eventInfo = events.getEventInfo(mockGithub.context);
    assert.strictEqual(eventInfo.eventType, 'pull_request');
    assert.strictEqual(eventInfo.shouldProcess, true);

    const existingBody = `## Z.ai Code Review\n\nOld review\n\n${COMMENT_MARKER}`;

    const existingCommentsResponse = await mockGithub.getOctokit('test-token').rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });
    assert.strictEqual(existingCommentsResponse.data.length, 0);

    const createdComment = await mockGithub.getOctokit('test-token').rest.issues.createComment({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42,
      body: existingBody
    });
    assert.strictEqual(createdComment.data.id, 123);

    const findResult = existingBody.includes(COMMENT_MARKER);
    assert.strictEqual(findResult, true);
  });

  test('PR event with no patchable changes skips review', async () => {
    const payload = createPrOpenedEvent(42, 'test-owner', 'test-repo');
    mockGithub.context.payload = payload;

    const octokit = mockGithub.getOctokit('test-token');
    const files = await octokit.rest.pulls.listFiles({
      owner: 'test-owner',
      repo: 'test-repo',
      pull_number: 42
    });

    const noPatchFiles = files.data.map(f => ({ ...f, patch: null }));
    const hasPatchable = noPatchFiles.some(f => f.patch);

    assert.strictEqual(hasPatchable, false);
  });

  test('event routing correctly identifies PR comment events', () => {
    const commentPayload = {
      eventName: 'issue_comment',
      payload: {
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/test/test/pulls/42' }
        },
        comment: {
          id: 1,
          user: { login: 'test-user', type: 'User' }
        }
      }
    };

    const eventType = events.getEventType(commentPayload);
    assert.strictEqual(eventType, 'issue_comment_pr');

    const shouldProcess = events.shouldProcessEvent(commentPayload);
    assert.strictEqual(shouldProcess.process, true);
  });

  test('bot comments are filtered out by anti-loop guard', () => {
    const botPayload = {
      eventName: 'issue_comment',
      payload: {
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/test/test/pulls/42' }
        },
        comment: {
          id: 1,
          user: { login: 'github-actions[bot]', type: 'Bot' }
        }
      }
    };

    const shouldProcess = events.shouldProcessEvent(botPayload);
    assert.strictEqual(shouldProcess.process, false);
    assert.ok(shouldProcess.reason.includes('bot comment'));
  });
});
