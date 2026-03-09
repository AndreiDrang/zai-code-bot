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
    expect(REACTIONS.EYES).toBe('eyes');
  });

  test('has THINKING constant', () => {
    expect(REACTIONS.THINKING).toBe('eyes');
  });

  test('has ROCKET constant', () => {
    expect(REACTIONS.ROCKET).toBe('rocket');
  });

  test('has X constant', () => {
    expect(REACTIONS.X).toBe('-1');
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
    expect(result.id).toBe(2);
    expect(result.body.includes('test-marker')).toBe(true);
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
    expect(result).toBe(null);
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
    expect(result).toBe(null);
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

    expect(createCalled).toBe(true);
    expect(result.action).toBe('created');
    expect(result.comment.id).toBe(100);
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

    expect(updateCalled).toBe(true);
    expect(result.action).toBe('updated');
    expect(result.comment.id).toBe(50);
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

    expect(createCalled).toBe(true);
    expect(result.action).toBe('created');
    expect(createParams.in_reply_to_comment_id).toBe(100);
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

    expect(listCommentsCalled).toBe(false);
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

    expect(result.success).toBe(true);
    expect(result.reaction.content).toBe('eyes');
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

    expect(result.success).toBe(false);
    expect(result.error).toBe('comment_not_found');
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

    await expect(
      addReaction(mockOctokit, 'owner', 'repo', 123, 'eyes')
    ).rejects.toThrow('Server Error');
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

    expect(result.oldReactionRemoved).toBe(true);
    expect(result.newReaction.success).toBe(true);
    expect(result.newReaction.reaction.content).toBe('rocket');
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

    expect(result.success).toBe(true);
    expect(result.reaction.content).toBe('thinking');
  });
});
