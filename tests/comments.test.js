const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  REACTIONS,
  findCommentByMarker,
  upsertComment,
  addReaction,
  updateReaction,
  setReaction,
} = require('../src/lib/comments.js');

describe('REACTIONS', () => {
  test('has EYES constant', () => {
    assert.strictEqual(REACTIONS.EYES, 'eyes');
  });

  test('has THINKING constant', () => {
    assert.strictEqual(REACTIONS.THINKING, 'eyes');
  });

  test('has ROCKET constant', () => {
    assert.strictEqual(REACTIONS.ROCKET, 'rocket');
  });

  test('has X constant', () => {
    assert.strictEqual(REACTIONS.X, '-1');
  });
});

describe('findCommentByMarker', () => {
  test('finds comment with matching marker', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 1, body: 'Hello world' },
              { id: 2, body: 'Some comment <!-- test-marker --> with marker' },
              { id: 3, body: 'Another comment' },
            ],
          }),
        },
      },
    };

    const result = await findCommentByMarker(mockOctokit, 'owner', 'repo', 1, 'test-marker');
    assert.strictEqual(result.id, 2);
    assert.strictEqual(result.body.includes('test-marker'), true);
  });

  test('returns null when no matching marker found', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 1, body: 'Hello world' },
              { id: 2, body: 'Another comment' },
            ],
          }),
        },
      },
    };

    const result = await findCommentByMarker(mockOctokit, 'owner', 'repo', 1, 'nonexistent');
    assert.strictEqual(result, null);
  });

  test('returns null when no comments exist', async () => {
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [],
          }),
        },
      },
    };

    const result = await findCommentByMarker(mockOctokit, 'owner', 'repo', 1, 'marker');
    assert.strictEqual(result, null);
  });
});

describe('upsertComment', () => {
  test('creates new comment when no existing comment with marker', async () => {
    let createCalled = false;
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async (params) => {
            createCalled = true;
            return { data: { id: 100, body: params.body } };
          },
          updateComment: async () => {
            throw new Error('updateComment should not be called');
          },
        },
      },
    };

    const result = await upsertComment(
      mockOctokit,
      'owner',
      'repo',
      1,
      'New comment body',
      '<!-- marker -->'
    );

    assert.strictEqual(createCalled, true);
    assert.strictEqual(result.action, 'created');
    assert.strictEqual(result.comment.id, 100);
  });

  test('updates existing comment when marker found', async () => {
    let updateCalled = false;
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({
            data: [
              { id: 50, body: 'Existing <!-- marker --> comment' },
            ],
          }),
          updateComment: async (params) => {
            updateCalled = true;
            return { data: { id: params.comment_id, body: params.body } };
          },
          createComment: async () => {
            throw new Error('createComment should not be called');
          },
        },
      },
    };

    const result = await upsertComment(
      mockOctokit,
      'owner',
      'repo',
      1,
      'Updated comment body',
      '<!-- marker -->'
    );

    assert.strictEqual(updateCalled, true);
    assert.strictEqual(result.action, 'updated');
    assert.strictEqual(result.comment.id, 50);
  });

  test('creates reply comment when replyToId provided', async () => {
    let createCalled = false;
    let createParams = null;
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => ({ data: [] }),
          createComment: async (params) => {
            createCalled = true;
            createParams = params;
            return { data: { id: 200, body: params.body } };
          },
        },
      },
    };

    const result = await upsertComment(
      mockOctokit,
      'owner',
      'repo',
      1,
      'Reply body',
      '<!-- marker -->',
      { replyToId: 100 }
    );

    assert.strictEqual(createCalled, true);
    assert.strictEqual(result.action, 'created');
    assert.strictEqual(createParams.in_reply_to_comment_id, 100);
  });

  test('skips finding existing when updateExisting is false', async () => {
    let listCommentsCalled = false;
    const mockOctokit = {
      rest: {
        issues: {
          listComments: async () => {
            listCommentsCalled = true;
            return { data: [] };
          },
          createComment: async () => ({ data: { id: 300 } }),
        },
      },
    };

    await upsertComment(
      mockOctokit,
      'owner',
      'repo',
      1,
      'New comment',
      '<!-- marker -->',
      { updateExisting: false }
    );

    assert.strictEqual(listCommentsCalled, false);
  });
});

describe('addReaction', () => {
  test('adds reaction successfully', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: async () => ({
            data: { id: 1, content: 'eyes' },
          }),
        },
      },
    };

    const result = await addReaction(mockOctokit, 'owner', 'repo', 123, 'eyes');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.reaction.content, 'eyes');
  });

  test('handles 404 error gracefully', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: async () => {
            const error = new Error('Not Found');
            error.status = 404;
            throw error;
          },
        },
      },
    };

    const result = await addReaction(mockOctokit, 'owner', 'repo', 123, 'eyes');

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'comment_not_found');
  });

  test('throws on non-404 errors', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: async () => {
            const error = new Error('Server Error');
            error.status = 500;
            throw error;
          },
        },
      },
    };

    await assert.rejects(
      addReaction(mockOctokit, 'owner', 'repo', 123, 'eyes'),
      { message: 'Server Error' }
    );
  });
});

describe('updateReaction', () => {
  test('adds new reaction', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: async () => ({
            data: { id: 1, content: 'rocket' },
          }),
        },
      },
    };

    const result = await updateReaction(
      mockOctokit,
      'owner',
      'repo',
      123,
      'eyes',
      'rocket'
    );

    assert.strictEqual(result.oldReactionRemoved, true);
    assert.strictEqual(result.newReaction.success, true);
    assert.strictEqual(result.newReaction.reaction.content, 'rocket');
  });
});

describe('setReaction', () => {
  test('delegates to addReaction', async () => {
    const mockOctokit = {
      rest: {
        reactions: {
          createForIssueComment: async () => ({
            data: { id: 1, content: 'thinking' },
          }),
        },
      },
    };

    const result = await setReaction(mockOctokit, 'owner', 'repo', 123, 'thinking');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.reaction.content, 'thinking');
  });
});
