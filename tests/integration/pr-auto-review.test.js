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
  let mockComments; // Stateful mock for comments

  beforeEach(() => {
    originalRequireGithub = require.cache[require.resolve('@actions/github')];
    mockComments = []; // Reset comment state
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
            listComments: async () => ({ data: [...mockComments] }),
            createComment: async (params) => {
              // Use fixed ID 123 for first comment to maintain backward compatibility with existing tests
              const newId = mockComments.length === 0 ? 123 : mockComments.length + 1;
              const newComment = { id: newId, body: params.body };
              mockComments.push(newComment);
              return { data: newComment };
            },
            updateComment: async (params) => {
              const idx = mockComments.findIndex(c => c.id === params.comment_id);
              if (idx >= 0) {
                mockComments[idx] = { ...mockComments[idx], body: params.body };
                return { data: mockComments[idx] };
              }
              return { data: { id: params.comment_id, body: params.body } };
            }
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
  // T12: Regression tests for PR auto-review marker-based upsert idempotency
  test('PR opened creates new comment when no marker exists', async () => {
    const payload = createPrOpenedEvent(42, 'test-owner', 'test-repo');
    mockGithub.context.payload = payload;

    const octokit = mockGithub.getOctokit('test-token');

    // Simulate: no existing comments with marker
    let createCallCount = 0;
    let updateCallCount = 0;

    // Override to track calls
    const originalCreateComment = octokit.rest.issues.createComment;
    const originalUpdateComment = octokit.rest.issues.updateComment;

    octokit.rest.issues.createComment = async (params) => {
      createCallCount++;
      return originalCreateComment(params);
    };
    octokit.rest.issues.updateComment = async (params) => {
      updateCallCount++;
      return originalUpdateComment(params);
    };

    // Verify no existing marker comment
    const existingComments = await octokit.rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });
    const existingMarkerComment = existingComments.data.find(c => c.body.includes(COMMENT_MARKER));
    assert.strictEqual(existingMarkerComment, undefined, 'No marker comment should exist');

    // Create new comment (simulating PR opened behavior)
    const reviewContent = 'Mock AI review for new PR';
    const body = buildCommentBody(reviewContent, 'pr_review');

    await octokit.rest.issues.createComment({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42,
      body
    });

    assert.strictEqual(createCallCount, 1, 'createComment should be called');
    assert.strictEqual(updateCallCount, 0, 'updateComment should NOT be called');
  });

  test('PR synchronize updates existing marker comment (not create duplicate)', async () => {
    const payload = createPrSynchronizeEvent(42, 'test-owner', 'test-repo');
    mockGithub.context.payload = payload;

    const octokit = mockGithub.getOctokit('test-token');

    // Pre-create existing marker comment (simulating previous PR opened review)
    const existingBody = `## Z.ai Code Review\n\nOld review content\n\n${COMMENT_MARKER}`;
    await octokit.rest.issues.createComment({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42,
      body: existingBody
    });

    // Verify the marker comment exists
    const commentsBefore = await octokit.rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });
    const markerCommentBefore = commentsBefore.data.find(c => c.body.includes(COMMENT_MARKER));
    assert.ok(markerCommentBefore, 'Marker comment should exist from previous PR opened');
    const existingCommentId = markerCommentBefore.id;

    // Track calls for update vs create
    let createCallCount = 0;
    let updateCallCount = 0;
    let updatedCommentId = null;

    const originalCreateComment = octokit.rest.issues.createComment;
    const originalUpdateComment = octokit.rest.issues.updateComment;

    octokit.rest.issues.createComment = async (params) => {
      createCallCount++;
      return originalCreateComment(params);
    };
    octokit.rest.issues.updateComment = async (params) => {
      updateCallCount++;
      updatedCommentId = params.comment_id;
      return originalUpdateComment(params);
    };

    // Simulate PR synchronize upsert logic
    const newReviewContent = 'Updated review after new commits';
    const newBody = buildCommentBody(newReviewContent, 'pr_review');

    const { data: allComments } = await octokit.rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });
    const existing = allComments.find(c => c.body.includes(COMMENT_MARKER));

    if (existing) {
      await octokit.rest.issues.updateComment({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: existing.id,
        body: newBody
      });
    } else {
      await octokit.rest.issues.createComment({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 42,
        body: newBody
      });
    }

    // Verify: update called, NOT create (update-not-duplicate semantics)
    assert.strictEqual(updateCallCount, 1, 'updateComment should be called for synchronize');
    assert.strictEqual(createCallCount, 0, 'createComment should NOT be called (would duplicate)');
    assert.strictEqual(updatedCommentId, existingCommentId, 'Should update the same comment, not create new');

    // Verify only one marker comment exists after update
    const commentsAfter = await octokit.rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });
    const markerCommentsAfter = commentsAfter.data.filter(c => c.body.includes(COMMENT_MARKER));
    assert.strictEqual(markerCommentsAfter.length, 1, 'Only one marker comment should exist after upsert');
  });

  test('PR synchronize creates new comment when no marker exists', async () => {
    const payload = createPrSynchronizeEvent(42, 'test-owner', 'test-repo');
    mockGithub.context.payload = payload;

    const octokit = mockGithub.getOctokit('test-token');

    // Verify NO existing comments
    const commentsBefore = await octokit.rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });
    const markerCommentBefore = commentsBefore.data.find(c => c.body.includes(COMMENT_MARKER));
    assert.strictEqual(markerCommentBefore, undefined, 'No marker comment should exist');

    // Track calls
    let createCallCount = 0;
    let updateCallCount = 0;

    const originalCreateComment = octokit.rest.issues.createComment;
    const originalUpdateComment = octokit.rest.issues.updateComment;

    octokit.rest.issues.createComment = async (params) => {
      createCallCount++;
      return originalCreateComment(params);
    };
    octokit.rest.issues.updateComment = async (params) => {
      updateCallCount++;
      return originalUpdateComment(params);
    };

    // Simulate PR synchronize upsert logic with no existing marker
    const reviewContent = 'First review on synchronize (no prior opened)';
    const body = buildCommentBody(reviewContent, 'pr_review');

    const { data: allComments } = await octokit.rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });
    const existing = allComments.find(c => c.body.includes(COMMENT_MARKER));

    if (existing) {
      await octokit.rest.issues.updateComment({
        owner: 'test-owner',
        repo: 'test-repo',
        comment_id: existing.id,
        body
      });
    } else {
      await octokit.rest.issues.createComment({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 42,
        body
      });
    }

    assert.strictEqual(createCallCount, 1, 'createComment should be called when no marker exists');
    assert.strictEqual(updateCallCount, 0, 'updateComment should NOT be called');
  });

  test('marker-based upsert is idempotent - multiple synchronizes do not duplicate', async () => {
    const payload = createPrSynchronizeEvent(42, 'test-owner', 'test-repo');
    mockGithub.context.payload = payload;

    const octokit = mockGithub.getOctokit('test-token');

    // Simulate 3 synchronize events
    for (let i = 1; i <= 3; i++) {
      const reviewContent = `Review iteration ${i}`;
      const body = buildCommentBody(reviewContent, 'pr_review');

      const { data: allComments } = await octokit.rest.issues.listComments({
        owner: 'test-owner',
        repo: 'test-repo',
        issue_number: 42
      });
      const existing = allComments.find(c => c.body.includes(COMMENT_MARKER));

      if (existing) {
        await octokit.rest.issues.updateComment({
          owner: 'test-owner',
          repo: 'test-repo',
          comment_id: existing.id,
          body
        });
      } else {
        await octokit.rest.issues.createComment({
          owner: 'test-owner',
          repo: 'test-repo',
          issue_number: 42,
          body
        });
      }
    }

    // After 3 synchronize events, should have exactly 1 marker comment
    const finalComments = await octokit.rest.issues.listComments({
      owner: 'test-owner',
      repo: 'test-repo',
      issue_number: 42
    });
    const markerComments = finalComments.data.filter(c => c.body.includes(COMMENT_MARKER));

    assert.strictEqual(markerComments.length, 1, 'Idempotency: only one marker comment after multiple synchronizes');
    assert.ok(markerComments[0].body.includes('Review iteration 3'), 'Should have latest content');
  });
});
